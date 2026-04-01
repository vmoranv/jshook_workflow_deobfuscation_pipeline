function toolNode(id, toolName, options) {
  return {
    kind: 'tool',
    id,
    toolName,
    input: options?.input,
    retry: options?.retry,
    timeoutMs: options?.timeoutMs,
  };
}
function sequenceNode(id, steps) {
  return { kind: 'sequence', id, steps };
}
function parallelNode(id, steps, maxConcurrency, failFast) {
  return { kind: 'parallel', id, steps, maxConcurrency, failFast };
}

const workflowId = 'workflow.deobfuscation-pipeline.v1';

const deobfuscationPipelineWorkflow = {
  kind: 'workflow-contract',
  version: 1,
  id: workflowId,
  displayName: 'Deobfuscation Pipeline',
  description:
    'End-to-end deobfuscation pipeline: collects scripts, detects obfuscation type (control flow flattening, string encoding, dead code, packer), runs webcrack unpacking, applies AST transforms (constant folding, dead code removal, control flow recovery), and produces cleaned source with diff report.',
  tags: ['reverse', 'deobfuscation', 'ast', 'webcrack', 'transform', 'obfuscation', 'mission'],
  timeoutMs: 15 * 60_000,
  defaultMaxConcurrency: 3,

  build(ctx) {
    const prefix = 'workflows.deobfuscationPipeline';
    const url = String(ctx.getConfig(`${prefix}.url`, 'https://example.com'));
    const waitUntil = String(ctx.getConfig(`${prefix}.waitUntil`, 'networkidle0'));
    const maxScripts = Number(ctx.getConfig(`${prefix}.maxScripts`, 30));
    const runWebcrack = Boolean(ctx.getConfig(`${prefix}.runWebcrack`, true));
    const runAstTransforms = Boolean(ctx.getConfig(`${prefix}.runAstTransforms`, true));
    const maxConcurrency = Number(ctx.getConfig(`${prefix}.parallel.maxConcurrency`, 3));

    const steps = [
      // Phase 1: Navigate
      toolNode('enable-network', 'network_enable', { input: { enableExceptions: true } }),
      toolNode('navigate', 'page_navigate', { input: { url, waitUntil } }),

      // Phase 2: Collect Scripts
      toolNode('collect-scripts', 'collect_code', {
        input: { includeInline: true, limit: maxScripts },
      }),

      // Phase 3: Parallel Detection
      parallelNode(
        'detect-obfuscation',
        [
          toolNode('detect-obfuscation', 'detect_obfuscation', { input: {} }),
          toolNode('detect-crypto', 'detect_crypto', { input: {} }),
          toolNode('search-packer-signatures', 'search_in_scripts', {
            input: { query: 'eval,Function,atob,fromCharCode,charCodeAt,replace,split,reverse,join', matchType: 'any' },
          }),
        ],
        maxConcurrency,
        false,
      ),

      // Phase 4: Source Map Recovery (may reveal original source)
      toolNode('recover-sourcemaps', 'source_map_extract', { input: {} }),
    ];

    // Phase 5: Webcrack Unpacking
    if (runWebcrack) {
      steps.push(toolNode('webcrack-unpack', 'webcrack_unpack', { input: {} }));
    }

    // Phase 6: AST Transform Pipeline
    if (runAstTransforms) {
      steps.push(
        toolNode('ast-preview', 'ast_transform_preview', { input: {} }),
        toolNode('ast-constant-fold', 'ast_transform_apply', {
          input: { transform: 'constant_fold' },
        }),
        toolNode('ast-dead-code', 'ast_transform_apply', {
          input: { transform: 'dead_code_remove' },
        }),
        toolNode('ast-control-flow', 'ast_transform_apply', {
          input: { transform: 'control_flow_flatten' },
        }),
      );
    }

    // Phase 7: Basic Deobfuscation
    steps.push(toolNode('deobfuscate', 'deobfuscate', { input: {} }));

    // Phase 8: Extract Function Tree from cleaned source
    steps.push(
      toolNode('extract-function-tree', 'extract_function_tree', {
        input: { depth: 3 },
      }),
    );

    // Phase 9: Evidence Recording
    steps.push(
      toolNode('create-evidence-session', 'instrumentation_session_create', {
        input: {
          name: `deobfuscation-${new Date().toISOString().slice(0, 10)}`,
          metadata: { url, workflowId },
        },
      }),
      toolNode('record-artifact', 'instrumentation_artifact_record', {
        input: {
          type: 'deobfuscation_result',
          label: `Deobfuscation for ${url}`,
          metadata: { url, runWebcrack, runAstTransforms },
        },
      }),

      // Phase 10: Session Insight
      toolNode('emit-insight', 'append_session_insight', {
        input: {
          insight: JSON.stringify({
            status: 'deobfuscation_pipeline_complete',
            workflowId,
            url,
            runWebcrack,
            runAstTransforms,
          }),
        },
      }),
    );

    return sequenceNode('deobfuscation-pipeline-root', steps);
  },

  onStart(ctx) {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'deobfuscation_pipeline', stage: 'start' });
  },
  onFinish(ctx) {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'deobfuscation_pipeline', stage: 'finish' });
  },
  onError(ctx, error) {
    ctx.emitMetric('workflow_errors_total', 1, 'counter', { workflowId, mission: 'deobfuscation_pipeline', stage: 'error', error: error.name });
  },
};

export default deobfuscationPipelineWorkflow;
