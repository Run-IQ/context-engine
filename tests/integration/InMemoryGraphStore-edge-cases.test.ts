import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryGraphStore } from '../../src/adapters/InMemoryGraphStore';
import { GraphNotFoundError } from '../../src/errors';
import type { SerializedGraph } from '../../src/stores/GraphStore';

const makeGraph = (overrides: Partial<SerializedGraph> = {}): SerializedGraph => ({
  id: 'graph-1',
  version: '1.0.0',
  tenantId: 'T1',
  createdAt: '2025-01-01T00:00:00Z',
  payload: '{}',
  checksum: 'abc',
  ...overrides,
});

describe('InMemoryGraphStore — edge cases', () => {
  let store: InMemoryGraphStore;

  beforeEach(() => {
    store = new InMemoryGraphStore();
  });

  it('getGraph for completely empty store throws GraphNotFoundError', async () => {
    await expect(store.getGraph('anything')).rejects.toThrow(GraphNotFoundError);
  });

  it('listGraphs on empty store returns empty array', async () => {
    expect(await store.listGraphs('T1')).toEqual([]);
  });

  it('listGraphs returns only the requested tenant — strict isolation', async () => {
    await store.saveGraph(makeGraph({ id: 'g1', tenantId: 'T1' }));
    await store.saveGraph(makeGraph({ id: 'g2', tenantId: 'T2' }));
    await store.saveGraph(makeGraph({ id: 'g3', tenantId: 'T1', version: '2.0.0' }));
    const list = await store.listGraphs('T1');
    expect(list).toHaveLength(2);
    expect(list.every((g) => g.tenantId === 'T1')).toBe(true);
  });

  it('latest alias updates with each saveGraph', async () => {
    await store.saveGraph(makeGraph({ version: '1.0.0' }));
    const v1 = await store.getGraph('graph-1');
    expect(v1.version).toBe('1.0.0');

    await store.saveGraph(makeGraph({ version: '2.0.0' }));
    const latest = await store.getGraph('graph-1');
    expect(latest.version).toBe('2.0.0');

    // But v1 is still retrievable directly
    const v1Again = await store.getGraph('graph-1', '1.0.0');
    expect(v1Again.version).toBe('1.0.0');
  });

  it('pruneGraphVersions with keepLast=0 removes all versions', async () => {
    await store.saveGraph(makeGraph({ version: '1.0.0', createdAt: '2025-01-01T00:00:00Z' }));
    await store.saveGraph(makeGraph({ version: '2.0.0', createdAt: '2025-02-01T00:00:00Z' }));
    await store.pruneGraphVersions('graph-1', 0);
    // All versioned entries removed, but 'latest' alias may still exist
    await expect(store.getGraph('graph-1', '1.0.0')).rejects.toThrow(GraphNotFoundError);
    await expect(store.getGraph('graph-1', '2.0.0')).rejects.toThrow(GraphNotFoundError);
  });

  it('pruneGraphVersions with keepLast > total versions keeps all', async () => {
    await store.saveGraph(makeGraph({ version: '1.0.0', createdAt: '2025-01-01T00:00:00Z' }));
    await store.saveGraph(makeGraph({ version: '2.0.0', createdAt: '2025-02-01T00:00:00Z' }));
    await store.pruneGraphVersions('graph-1', 100);
    // Both still retrievable
    const v1 = await store.getGraph('graph-1', '1.0.0');
    const v2 = await store.getGraph('graph-1', '2.0.0');
    expect(v1.version).toBe('1.0.0');
    expect(v2.version).toBe('2.0.0');
  });

  it('pruneGraphVersions on non-existent graphId does nothing', async () => {
    // Should not throw
    await store.pruneGraphVersions('nonexistent', 2);
  });

  it('saveCompiledGraph then getCompiledGraph with different graph IDs', async () => {
    await store.saveCompiledGraph({
      hash: 'hash-1',
      graphId: 'g1',
      version: '1.0.0',
      compiledAt: '2025-01-01T00:00:00Z',
      dgVersion: '1.0.0',
      payload: '{"compiled":true}',
    });
    await store.saveCompiledGraph({
      hash: 'hash-2',
      graphId: 'g2',
      version: '1.0.0',
      compiledAt: '2025-01-01T00:00:00Z',
      dgVersion: '1.0.0',
      payload: '{"compiled":true}',
    });
    expect(await store.getCompiledGraph('hash-1')).not.toBeNull();
    expect(await store.getCompiledGraph('hash-2')).not.toBeNull();
    expect(await store.getCompiledGraph('hash-3')).toBeNull();
  });

  it('multiple graphs, multiple tenants, multiple versions — full isolation', async () => {
    for (let t = 1; t <= 3; t++) {
      for (let g = 1; g <= 3; g++) {
        for (let v = 1; v <= 3; v++) {
          await store.saveGraph(
            makeGraph({
              id: `g${g}`,
              tenantId: `T${t}`,
              version: `${t}.${g}.${v}`,
              createdAt: `2025-0${t}-0${g}T0${v}:00:00Z`,
            }),
          );
        }
      }
    }

    const t1 = await store.listGraphs('T1');
    const t2 = await store.listGraphs('T2');
    const t3 = await store.listGraphs('T3');

    // Each tenant has 3 graphs × 3 versions = 9 entries (excluding :latest aliases)
    expect(t1).toHaveLength(9);
    expect(t2).toHaveLength(9);
    expect(t3).toHaveLength(9);

    // All T1 entries belong to T1
    expect(t1.every((g) => g.tenantId === 'T1')).toBe(true);
  });
});
