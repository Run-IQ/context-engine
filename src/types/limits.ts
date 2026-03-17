export interface ContextLimits {
  readonly maxValueSizeKb?: number;
  readonly maxTotalSizeKb?: number;
  readonly maxEntries?: number;
  readonly allowRawOverwrite?: boolean;
}
