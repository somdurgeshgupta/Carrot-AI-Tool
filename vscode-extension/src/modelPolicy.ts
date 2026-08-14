export interface CarrotModel {
  id: string;
  model: string;
  name: string;
  provider: string;
  location: 'local' | 'cloud';
  type: 'chat' | 'embedding';
  available: boolean;
  agentProtocol?: 'structured-json';
  agentToolStatus?: 'untested' | 'tested' | 'failed';
  preferredForCodingAgent?: boolean;
  supportsNativeTools?: boolean;
}

export function selectableChatModels(models: CarrotModel[], localOnly: boolean): CarrotModel[] {
  return models.filter((model) => model.type === 'chat'
    && model.available
    && (!localOnly || model.location === 'local'));
}

export function validateModelSelection(models: CarrotModel[], selectedId: string, localOnly: boolean): void {
  if (selectedId === 'auto') return;
  const selected = models.find((model) => model.id === selectedId);
  if (!selected || !selected.available) throw new Error(`Selected model is unavailable: ${selectedId}`);
  if (selected.type !== 'chat') throw new Error('Embedding models cannot be selected for chat.');
  if (localOnly && selected.location !== 'local') throw new Error('Local-only mode blocks cloud models.');
}
