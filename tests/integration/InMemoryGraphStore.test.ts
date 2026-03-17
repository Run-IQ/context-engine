import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryGraphStore } from '../../src/adapters/InMemoryGraphStore';
import { GraphNotFoundError, GraphVersionConflictError } from '../../src/errors';
import type { SerializedGraph, SerializedCompiledGraph } from '../../src/stores/GraphStore';

const makeGraph = (overrides: Partial<SerializedGraph> = {}): SerializedGraph => ({
  id: 'graph-1',
  version: '1.0.0',
  tenantId: 'T1',
  createdAt: '2025-01-01T00:00:00Z',
  payload: '{}',
  checksum: 'abc123',
  ...overrides,
});

describe('InMemoryGraphStore', () => {
  let store: InMemoryGraphStore;

  beforeEach(() => {
    store = new InMemoryGraphStore();
  });

  it('saveGraph then getGraph returns the same graph', async () => {
    const graph = makeGraph();
    await store.saveGraph(graph);
    const result = await store.getGraph('graph-1', '1.0.0');
    expect(result).toEqual(graph);
  });

  it('saveGraph twice with same id+version throws GraphVersionConflictError', async () => {
    const graph = makeGraph();
    await store.saveGraph(graph);
    await expect(store.saveGraph(graph)).rejects.toThrow(GraphVersionConflictError);
  });

  it('getGraph without version returns the latest alias', async () => {
    await store.saveGraph(makeGraph({ version: '1.0.0' }));
    await store.saveGraph(makeGraph({ version: '2.0.0', createdAt: '2025-02-01T00:00:00Z' }));
    const result = await store.getGraph('graph-1');
    expect(result.version).toBe('2.0.0');
  });

  it('getGraph with non-existent version throws GraphNotFoundError', async () => {
    await expect(store.getGraph('graph-1', '9.9.9')).rejects.toThrow(GraphNotFoundError);
  });

  it('saveCompiledGraph then getCompiledGraph returns the same compiled', async () => {
    const compiled: SerializedCompiledGraph = {
      hash: 'sha-1',
      graphId: 'graph-1',
      version: '1.0.0',
      compiledAt: '2025-01-01T00:00:00Z',
      dgVersion: '1.0.0',
      payload: '{}',
    };
    await store.saveCompiledGraph(compiled);
    const result = await store.getCompiledGraph('sha-1');
    expect(result).toEqual(compiled);
  });

  it('getCompiledGraph with non-existent hash returns null', async () => {
    const result = await store.getCompiledGraph('nonexistent');
    expect(result).toBeNull();
  });

  it('saveCompiledGraph is idempotent — same hash twice, no error', async () => {
    const compiled: SerializedCompiledGraph = {
      hash: 'sha-1',
      graphId: 'graph-1',
      version: '1.0.0',
      compiledAt: '2025-01-01T00:00:00Z',
      dgVersion: '1.0.0',
      payload: '{}',
    };
    await store.saveCompiledGraph(compiled);
    await store.saveCompiledGraph(compiled);
    const result = await store.getCompiledGraph('sha-1');
    expect(result).toEqual(compiled);
  });

  it('listGraphs filters by tenantId and excludes latest alias', async () => {
    await store.saveGraph(makeGraph({ tenantId: 'T1' }));
    await store.saveGraph(makeGraph({ id: 'graph-2', tenantId: 'T2' }));
    const list = await store.listGraphs('T1');
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe('graph-1');
  });

  it('pruneGraphVersions keeps N versions and removes the oldest', async () => {
    await store.saveGraph(makeGraph({ version: '1.0.0', createdAt: '2025-01-01T00:00:00Z' }));
    await store.saveGraph(makeGraph({ version: '2.0.0', createdAt: '2025-02-01T00:00:00Z' }));
    await store.saveGraph(makeGraph({ version: '3.0.0', createdAt: '2025-03-01T00:00:00Z' }));
    await store.pruneGraphVersions('graph-1', 2);
    // Should keep 3.0.0 and 2.0.0, remove 1.0.0
    await expect(store.getGraph('graph-1', '1.0.0')).rejects.toThrow(GraphNotFoundError);
    const v2 = await store.getGraph('graph-1', '2.0.0');
    expect(v2.version).toBe('2.0.0');
  });
});
