export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ContextConflictError extends ContextError {}

export class ContextLimitError extends ContextError {}

export class ContextValidationError extends ContextError {}

export class GraphNotFoundError extends ContextError {}

export class GraphVersionConflictError extends ContextError {}

export class ExecutionNotFoundError extends ContextError {}

export class RuleNotFoundError extends ContextError {}

export class RuleVersionConflictError extends ContextError {}

export class RuleTransitionError extends ContextError {}

export class RulePublishError extends ContextError {}
