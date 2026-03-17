export interface SerializedGraph {
  readonly id: string;
  readonly version: string;
  readonly tenantId: string;
  readonly createdAt: string;
  readonly payload: string;
  readonly checksum: string;
}

export interface SerializedCompiledGraph {
  readonly hash: string;
  readonly graphId: string;
  readonly version: string;
  readonly compiledAt: string;
  readonly dgVersion: string;
  readonly payload: string;
}

export interface GraphMetadata {
  readonly id: string;
  readonly version: string;
  readonly tenantId: string;
  readonly description?: string;
  readonly domain?: string;
  readonly tags?: readonly string[];
  readonly createdAt: string;
}

export interface GraphStore {
  getGraph(graphId: string, version?: string): Promise<SerializedGraph>;
  saveGraph(graph: SerializedGraph): Promise<void>;
  getCompiledGraph(hash: string): Promise<SerializedCompiledGraph | null>;
  saveCompiledGraph(compiled: SerializedCompiledGraph): Promise<void>;
  listGraphs(tenantId: string): Promise<GraphMetadata[]>;
  pruneGraphVersions(graphId: string, keepLast: number): Promise<void>;
}
