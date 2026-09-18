export type ControllerSnapshot<T> = T extends object
  ? { readonly [K in keyof T]: ControllerSnapshot<T[K]> }
  : T;

/**
 * Capture small controller projections, not entire history/comparison payloads.
 * Inputs are plain records/arrays/scalars; project mutable maps into entries first.
 * Only publish reads the owner. Reads and unchanged snapshot branches are cached.
 * Subscription cleanup does not dispose the owner. Disposal retains the final
 * snapshot, stops publication, and rejects new subscriptions.
 */
export function createControllerStore<T>(read: () => T) {
  const owned = new WeakSet<object>();
  function capture(value: unknown, previous: unknown, ancestors = new Set<object>()): unknown {
    if (value === null || typeof value !== "object") {
      if (typeof value === "function") throw new TypeError("Controller snapshots cannot contain functions");
      return value;
    }
    if (owned.has(value)) return value;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Controller snapshots require plain records and arrays; project mutable collections first");
    }
    if (ancestors.has(value)) throw new TypeError("Controller snapshots cannot contain cycles");
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      const prior = previous !== null && typeof previous === "object" &&
        Array.isArray(previous) === array && Object.getPrototypeOf(previous) === prototype
        ? previous : undefined;
      let unchanged = prior !== undefined && Reflect.ownKeys(prior).length === keys.length;
      const next: Record<PropertyKey, unknown> = array
        ? [] as unknown as Record<PropertyKey, unknown> : Object.create(prototype);
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!("value" in descriptor)) throw new TypeError("Controller snapshots cannot contain accessors");
        const before = prior && Object.getOwnPropertyDescriptor(prior, key);
        const child = capture(descriptor.value, before?.value, ancestors);
        if (!before || !Object.is(child, before.value)) unchanged = false;
        Object.defineProperty(next, key, {
          value: child, enumerable: descriptor.enumerable, writable: true,
          configurable: key !== "length" || !array,
        });
      }
      if (unchanged) return prior;
      Object.freeze(next);
      owned.add(next);
      return next;
    } finally {
      ancestors.delete(value);
    }
  }

  let snapshot = capture(read(), undefined) as ControllerSnapshot<T>;
  let disposed = false;
  const subscriptions = new Set<{ listener: () => void }>();
  return {
    getSnapshot: (): ControllerSnapshot<T> => snapshot,
    subscribe(listener: () => void) {
      if (disposed) throw new Error("Controller store is disposed");
      const subscription = { listener };
      subscriptions.add(subscription);
      return () => { subscriptions.delete(subscription); };
    },
    publish() {
      if (disposed) return false;
      const next = capture(read(), snapshot) as ControllerSnapshot<T>;
      if (Object.is(next, snapshot)) return false;
      snapshot = next;
      const errors: unknown[] = [];
      for (const subscription of [...subscriptions]) {
        if (!subscriptions.has(subscription)) continue;
        try { subscription.listener(); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Controller subscription failed");
      return true;
    },
    dispose() {
      disposed = true;
      subscriptions.clear();
    },
  };
}
