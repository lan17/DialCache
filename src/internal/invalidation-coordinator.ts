import type {
  DialCacheInvalidationCoordinator,
  DialCacheInvalidationCoordinatorListener,
  DialCacheInvalidationCoordinatorState,
  DialCacheLocalInvalidation,
} from "../invalidation.js";
import { DialCacheRedisProtocolError } from "../redis-client.js";
import {
  decodeRedisInvalidationEvent,
  isValidLocalInvalidation,
  localInvalidationFromEvent,
  redisInvalidationChannel,
} from "./invalidation-event.js";

/**
 * Shared implementation used by first-party transports. It deliberately owns
 * no Redis resources; adapters drive health and payload delivery.
 */
export class InvalidationCoordinator implements DialCacheInvalidationCoordinator {
  readonly channel: string;
  private readonly listeners = new Set<DialCacheInvalidationCoordinatorListener>();
  private currentState: DialCacheInvalidationCoordinatorState = "unavailable";

  constructor(readonly namespace: string) {
    this.channel = redisInvalidationChannel(namespace);
  }

  get state(): DialCacheInvalidationCoordinatorState {
    return this.currentState;
  }

  addListener(listener: DialCacheInvalidationCoordinatorListener): () => void {
    if (this.currentState === "disposed") {
      callListener(() => listener.onStateChange("disposed"));
      return () => undefined;
    }

    this.listeners.add(listener);
    callListener(() => listener.onStateChange(this.currentState));
    let listening = true;
    return () => {
      if (!listening) {
        return;
      }
      listening = false;
      this.listeners.delete(listener);
    };
  }

  invalidate(invalidation: DialCacheLocalInvalidation): boolean {
    if (this.currentState === "disposed") {
      return false;
    }
    if (!isValidLocalInvalidation(invalidation, this.namespace)) {
      this.unavailable(new DialCacheRedisProtocolError("Invalid DialCache local invalidation"));
      return false;
    }

    for (const listener of [...this.listeners]) {
      if (this.state === "disposed") {
        break;
      }
      callListener(() => listener.onInvalidation(invalidation));
    }
    return true;
  }

  receive(payload: string | Buffer, channel = this.channel): boolean {
    if (this.currentState === "disposed") {
      return false;
    }
    try {
      if (channel !== this.channel) {
        throw new DialCacheRedisProtocolError("Invalid DialCache invalidation channel");
      }
      const event = decodeRedisInvalidationEvent(payload, { namespace: this.namespace });
      return this.invalidate(localInvalidationFromEvent(event));
    } catch (error) {
      this.unavailable(error);
      return false;
    }
  }

  ready(): void {
    this.transition("ready");
  }

  unavailable(error?: unknown): void {
    this.transition("unavailable", error);
  }

  dispose(): void {
    if (this.currentState === "disposed") {
      return;
    }
    this.transition("disposed");
    this.listeners.clear();
  }

  private transition(state: DialCacheInvalidationCoordinatorState, error?: unknown): void {
    if (this.currentState === "disposed" || state === this.currentState) {
      return;
    }
    this.currentState = state;
    for (const listener of [...this.listeners]) {
      if (this.currentState !== state) {
        break;
      }
      callListener(() => listener.onStateChange(state, error));
    }
  }
}

function callListener(call: () => void): void {
  try {
    call();
  } catch {
    // One DialCache instance must not prevent sibling instances from converging.
  }
}
