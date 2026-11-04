import { Engine } from '../harness/engine';
import { ChatProvider } from '../harness/provider';
import { SqliteStore } from '../harness/store';
import path from 'node:path';
import type { Command, ModelConfig } from '../shared/types';

const port = (process as unknown as { parentPort: { postMessage(value: unknown): void; on(name: string, callback: (event: {data: any}) => void): void } }).parentPort;
let engine: Engine;
let config: ModelConfig | null = null;
port.on('message', async ({ data }) => {
  try {
    let result: unknown;
    if (data.type === 'init') {
      config = data.config;
      engine = new Engine({ store: new SqliteStore(path.join(data.dataDir, 'workspace.sqlite'), data.wasmPath), provider: new ChatProvider(() => config), onChange: state => port.postMessage({ type: 'state', state }), delayMs: data.test ? 5 : 550 });
      result = await engine.init();
    } else if (!engine) throw new Error('运行引擎尚未就绪。');
    else if (data.type === 'state') result = engine.getState();
    else if (data.type === 'command') result = await engine.command(data.command as Command);
    else if (data.type === 'configure') { result = await engine.invalidateModelApprovals(); config = data.config; }
    else if (data.type === 'shutdown') { await engine.shutdown(); result = true; }
    else throw new Error('未知运行请求。');
    port.postMessage({ type: 'reply', id: data.id, result });
  } catch (error) {
    const raw = error instanceof Error ? error.message : '运行请求失败。';
    const message = config?.apiKey ? raw.split(config.apiKey).join('[已隐藏]') : raw;
    port.postMessage({ type: 'reply', id: data.id, error: message.slice(0, 1500) });
  }
});
