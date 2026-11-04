import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, ArborunBridge } from '../shared/types';
const bridge: ArborunBridge = {
  getState: () => ipcRenderer.invoke('arborun:state'),
  command: command => ipcRenderer.invoke('arborun:command', command),
  importSources: taskId => ipcRenderer.invoke('arborun:import', taskId),
  exportTask: taskId => ipcRenderer.invoke('arborun:export', taskId),
  modelConfig: () => ipcRenderer.invoke('arborun:config'),
  saveModelConfig: config => ipcRenderer.invoke('arborun:save-config', config),
  onState: listener => {
    const callback = (_event: unknown, state: AppState) => listener(state);
    ipcRenderer.on('arborun:changed', callback);
    return () => ipcRenderer.removeListener('arborun:changed', callback);
  },
};
contextBridge.exposeInMainWorld('arborun', bridge);
