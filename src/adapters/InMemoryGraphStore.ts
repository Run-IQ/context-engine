import type {
  GraphStore,
  SerializedGraph,
  SerializedCompiledGraph,
  GraphMetadata,
} from '../stores/GraphStore.js';
import { GraphNotFoundError, GraphVersionConflictError } from '../errors.js';

export class InMemoryGraphStore implements GraphStore {
  private readonly graphs: Map<string, SerializedGraph> = new Map();
  private readonly compiled: Map<string, SerializedCompiledGraph> = new Map();

  async getGraph(graphId: string, version?: string): Promise<SerializedGraph> {
    const key = version ? `${graphId}:${version}` : `${graphId}:latest`;
    const graph = this.graphs.get(key);
    if (!graph) {
      throw new GraphNotFoundError(
        `Graph "${graphId}"${version ? ` version "${version}"` : ' (latest)'} not found`,
      );
    }
    return graph;
  }

  async saveGraph(graph: SerializedGraph): Promise<void> {
    const versionKey = `${graph.id}:${graph.version}`;
    if (this.graphs.has(versionKey)) {
      throw new GraphVersionConflictError(
        `Graph "${graph.id}" version "${graph.version}" already exists. ` +
          `Versions are immutable — bump the version to publish a new revision.`,
      );
    }
    this.graphs.set(versionKey, graph);
    this.graphs.set(`${graph.id}:latest`, graph);
  }

  async getCompiledGraph(hash: string): Promise<SerializedCompiledGraph | null> {
    return this.compiled.get(hash) ?? null;
  }

  async saveCompiledGraph(compiled: SerializedCompiledGraph): Promise<void> {
    if (!this.compiled.has(compiled.hash)) {
      this.compiled.set(compiled.hash, compiled);
    }
  }

  async listGraphs(tenantId: string): Promise<GraphMetadata[]> {
    return [...this.graphs.entries()]
      .filter(([key, g]) => g.tenantId === tenantId && !key.endsWith(':latest'))
      .map(([, g]) => ({
        id: g.id,
        version: g.version,
        tenantId: g.tenantId,
        createdAt: g.createdAt,
      }));
  }

  async pruneGraphVersions(graphId: string, keepLast: number): Promise<void> {
    const versions = [...this.graphs.entries()]
      .filter(([key]) => key.startsWith(`${graphId}:`) && !key.endsWith(':latest'))
      .sort(([, a], [, b]) => b.createdAt.localeCompare(a.createdAt));

    versions.slice(keepLast).forEach(([key]) => this.graphs.delete(key));
  }
}
