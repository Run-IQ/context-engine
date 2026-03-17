import { describe, it, expect } from 'vitest';
import {
  ContextError,
  ContextConflictError,
  ContextLimitError,
  ContextValidationError,
  GraphNotFoundError,
  GraphVersionConflictError,
  ExecutionNotFoundError,
  RuleNotFoundError,
  RuleVersionConflictError,
  RuleTransitionError,
  RulePublishError,
} from '../../src/errors';

describe('Error hierarchy', () => {
  it('all errors are instanceof Error', () => {
    const errors = [
      new ContextError('msg'),
      new ContextConflictError('msg'),
      new ContextLimitError('msg'),
      new ContextValidationError('msg'),
      new GraphNotFoundError('msg'),
      new GraphVersionConflictError('msg'),
      new ExecutionNotFoundError('msg'),
      new RuleNotFoundError('msg'),
      new RuleVersionConflictError('msg'),
      new RuleTransitionError('msg'),
      new RulePublishError('msg'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('all errors are instanceof ContextError', () => {
    const errors = [
      new ContextConflictError('msg'),
      new ContextLimitError('msg'),
      new ContextValidationError('msg'),
      new GraphNotFoundError('msg'),
      new GraphVersionConflictError('msg'),
      new ExecutionNotFoundError('msg'),
      new RuleNotFoundError('msg'),
      new RuleVersionConflictError('msg'),
      new RuleTransitionError('msg'),
      new RulePublishError('msg'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(ContextError);
    }
  });

  it('instanceof checks are specific — no false positives', () => {
    const conflict = new ContextConflictError('msg');
    expect(conflict).toBeInstanceOf(ContextConflictError);
    expect(conflict).not.toBeInstanceOf(ContextLimitError);
    expect(conflict).not.toBeInstanceOf(ContextValidationError);
    expect(conflict).not.toBeInstanceOf(GraphNotFoundError);
  });

  it('error.name matches the class name', () => {
    expect(new ContextError('msg').name).toBe('ContextError');
    expect(new ContextConflictError('msg').name).toBe('ContextConflictError');
    expect(new ContextLimitError('msg').name).toBe('ContextLimitError');
    expect(new ContextValidationError('msg').name).toBe('ContextValidationError');
    expect(new GraphNotFoundError('msg').name).toBe('GraphNotFoundError');
    expect(new GraphVersionConflictError('msg').name).toBe('GraphVersionConflictError');
    expect(new ExecutionNotFoundError('msg').name).toBe('ExecutionNotFoundError');
    expect(new RuleNotFoundError('msg').name).toBe('RuleNotFoundError');
    expect(new RuleVersionConflictError('msg').name).toBe('RuleVersionConflictError');
    expect(new RuleTransitionError('msg').name).toBe('RuleTransitionError');
    expect(new RulePublishError('msg').name).toBe('RulePublishError');
  });

  it('error.message is preserved', () => {
    const err = new ContextConflictError('Key "x" already exists');
    expect(err.message).toBe('Key "x" already exists');
  });

  it('error.stack is available', () => {
    const err = new ContextError('test');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('ContextError');
  });

  it('works in try/catch with typed catch', () => {
    try {
      throw new GraphNotFoundError('Graph "g1" not found');
    } catch (e) {
      expect(e).toBeInstanceOf(ContextError);
      expect(e).toBeInstanceOf(GraphNotFoundError);
      expect((e as Error).message).toContain('g1');
    }
  });
});
