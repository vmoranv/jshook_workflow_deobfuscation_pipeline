import {
  createWorkflow,
  type WorkflowExecutionContext,
  SequenceNodeBuilder,
} from '@jshookmcp/extension-sdk/workflow';

const workflowId = 'workflow.deobfuscation-pipeline.v1';

export default createWorkflow(workflowId, 'Deobfuscation Pipeline')
  .description(
    'End-to-end deobfuscation pipeline: collects scripts, detects obfuscation type (control flow flattening, string encoding, dead code, packer), runs webcrack unpacking, applies AST transforms (constant folding, dead code removal, control flow recovery), and produces cleaned source with diff report.',
  )
  .tags(['reverse', 'deobfuscation', 'ast', 'webcrack', 'transform', 'obfuscation', 'mission'])
  .timeoutMs(15 * 60_000)
  .defaultMaxConcurrency(3)
  .buildGraph((ctx: WorkflowExecutionContext) => {
    const prefix = 'workflows.deobfuscationPipeline';
    const url = String(ctx.getConfig(`${prefix}.url`, 'https://example.com'));
    const waitUntil = String(ctx.getConfig(`${prefix}.waitUntil`, 'networkidle0'));
    const maxScripts = Number(ctx.getConfig(`${prefix}.maxScripts`, 30));
    const runWebcrack = Boolean(ctx.getConfig(`${prefix}.runWebcrack`, true));
    const runAstTransforms = Boolean(ctx.getConfig(`${prefix}.runAstTransforms`, true));
    const maxConcurrency = Number(ctx.getConfig(`${prefix}.parallel.maxConcurrency`, 3));

    const root = new SequenceNodeBuilder('deobfuscation-pipeline-root');

    // Phase 1: Navigate
    root
      .tool('enable-network', 'network_enable', { input: { enableExceptions: true } })
      .tool('navigate', 'page_navigate', { input: { url, waitUntil } })

      // Phase 2: Collect Scripts
      .tool('collect-scripts', 'collect_code', {
        input: { includeInline: true, limit: maxScripts },
      })

      // Phase 3: Parallel Detection
      .parallel('detect-obfuscation', (p) => {
        p.maxConcurrency(maxConcurrency)
          .failFast(false)
          .tool('detect-obfuscation', 'detect_obfuscation', { input: {} })
          .tool('detect-crypto', 'detect_crypto', { input: {} })
          .tool('search-packer-signatures', 'search_in_scripts', {
            input: { query: 'eval,Function,atob,fromCharCode,charCodeAt,replace,split,reverse,join', matchType: 'any' },
          });
      })

      // Phase 4: Source Map Recovery (may reveal original source)
      .tool('recover-sourcemaps', 'source_map_extract', { input: {} });

    // Phase 5: Webcrack Unpacking
    if (runWebcrack) {
      root.tool('webcrack-unpack', 'webcrack_unpack', { input: {} });
    }

    // Phase 6: AST Transform Pipeline
    if (runAstTransforms) {
      root
        .tool('ast-preview', 'ast_transform_preview', { input: {} })
        .tool('ast-constant-fold', 'ast_transform_apply', {
          input: { transform: 'constant_fold' },
        })
        .tool('ast-dead-code', 'ast_transform_apply', {
          input: { transform: 'dead_code_remove' },
        })
        .tool('ast-control-flow', 'ast_transform_apply', {
          input: { transform: 'control_flow_flatten' },
        });
    }

    // Phase 7: Basic Deobfuscation
    root.tool('deobfuscate', 'deobfuscate', { input: {} });

    // Phase 8: Extract Function Tree from cleaned source
    root.tool('extract-function-tree', 'extract_function_tree', {
      input: { depth: 3 },
    });

    // Phase 9: Evidence Recording
    root
      .tool('create-evidence-session', 'instrumentation_session_create', {
        input: {
          name: `deobfuscation-${new Date().toISOString().slice(0, 10)}`,
          metadata: { url, workflowId },
        },
      })
      .tool('record-artifact', 'instrumentation_artifact_record', {
        input: {
          type: 'deobfuscation_result',
          label: `Deobfuscation for ${url}`,
          metadata: { url, runWebcrack, runAstTransforms },
        },
      })

      // Phase 10: Session Insight
      .tool('emit-insight', 'append_session_insight', {
        input: {
          insight: JSON.stringify({
            status: 'deobfuscation_pipeline_complete',
            workflowId,
            url,
            runWebcrack,
            runAstTransforms,
          }),
        },
      });

    return root;
  })
  .onStart((ctx) => {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'deobfuscation_pipeline', stage: 'start' });
  })
  .onFinish((ctx) => {
    ctx.emitMetric('workflow_runs_total', 1, 'counter', { workflowId, mission: 'deobfuscation_pipeline', stage: 'finish' });
  })
  .onError((ctx, error) => {
    ctx.emitMetric('workflow_errors_total', 1, 'counter', { workflowId, mission: 'deobfuscation_pipeline', stage: 'error', error: error.name });
  })
  .build();
