import type { z } from "zod";

/**
 * Whether `Schema` takes every body the contract allows, and reads every field
 * of it: zod drops a field it doesn't know, so one the contract has and the
 * schema lacks would vanish without an error. A schema whose input is unknown
 * (one that preprocesses) can't be checked and passes.
 */
type TakesBody<Schema extends z.ZodTypeAny, Body> =
  unknown extends z.input<Schema>
    ? true
    : [Body] extends [z.input<Schema>]
      ? [Exclude<keyof Body, keyof z.input<Schema>>] extends [never]
        ? true
        : false
      : false;

/**
 * Returns `schema` unchanged, once the type check has confirmed it takes and
 * reads every body the contract allows: `takesBody<SendMessageBody>()(schema)`.
 * A mismatch fails here, at compile time, rather than as a 400 or a silently
 * dropped field.
 */
export function takesBody<Body>() {
  return <Schema extends z.ZodTypeAny>(
    schema: Schema & (TakesBody<Schema, Body> extends true ? unknown : never),
  ): Schema => schema;
}
