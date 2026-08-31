/**
 * A deliberately small JSON Schema validator.
 *
 * Why not ajv: the pinger has to run with zero runtime dependencies inside a
 * workflow, and validation runs in that same process (a bad config should fail
 * *before* any request goes out, not only in CI). Vendoring a full validator
 * for that would be the single heaviest thing in the repo. Instead this
 * implements the subset `config/targets.schema.json` actually uses, so the
 * schema file stays the one source of truth for both CI and runtime and both
 * produce byte-identical messages.
 *
 * Supported: $ref (local), type, enum, const, required, properties,
 * additionalProperties, items, minItems, uniqueItems, minLength, pattern,
 * minimum, maximum, allOf, anyOf, oneOf, not, if/then/else.
 *
 * Anything else in a schema is ignored rather than silently passing something
 * false: `assertSupportedSchema()` fails loudly if the schema grows a keyword
 * this validator does not implement.
 */

/**
 * @typedef {object} SchemaError
 * @property {string} path JSON-path-ish location, e.g. `targets[2].timeoutMs`.
 * @property {string} message Human-readable, complete on its own line.
 */

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);

/**
 * Walk a schema and throw if it uses a keyword this validator does not
 * implement. Called by the config validator so an unsupported keyword can
 * never quietly become a rule that is not enforced.
 *
 * @param {unknown} schema
 * @param {string} [path]
 * @returns {void}
 */
export function assertSupportedSchema(schema, path = '#') {
  if (typeof schema === 'boolean' || schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => assertSupportedSchema(item, `${path}/${i}`));
    return;
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `targets.schema.json uses the JSON Schema keyword "${keyword}" at ${path}, which src/config/schema.js does not implement. ` +
          `Implement it there (and add it to SUPPORTED_KEYWORDS) or remove it from the schema - otherwise the rule would be silently unenforced.`
      );
    }
    if (keyword === 'properties' || keyword === '$defs') {
      for (const [key, sub] of Object.entries(/** @type {object} */ (value))) {
        assertSupportedSchema(sub, `${path}/${keyword}/${key}`);
      }
    } else if (['allOf', 'anyOf', 'oneOf'].includes(keyword)) {
      assertSupportedSchema(value, `${path}/${keyword}`);
    } else if (['items', 'not', 'if', 'then', 'else', 'additionalProperties'].includes(keyword)) {
      assertSupportedSchema(value, `${path}/${keyword}`);
    }
  }
}

/**
 * Validate `data` against `schema`.
 *
 * @param {unknown} data
 * @param {object} schema
 * @returns {SchemaError[]} Empty when valid.
 */
export function validateSchema(data, schema) {
  return check(data, schema, '', schema);
}

/**
 * @param {unknown} data
 * @param {unknown} schema
 * @param {string} path
 * @param {object} root
 * @returns {SchemaError[]}
 */
function check(data, schema, path, root) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [err(path, 'no value is allowed here')];
  if (typeof schema !== 'object' || schema === null) return [];

  const node = /** @type {Record<string, any>} */ (schema);
  if (typeof node.$ref === 'string') return check(data, resolveRef(node.$ref, root), path, root);

  /** @type {SchemaError[]} */
  const errors = [];

  if (node.type !== undefined && !matchesType(data, node.type)) {
    errors.push(err(path, `expected ${describeType(node.type)} but got ${typeName(data)}`));
    return errors; // Further keywords would only produce noise on the wrong type.
  }

  if (
    node.enum !== undefined &&
    !node.enum.some((/** @type {unknown} */ v) => deepEqual(v, data))
  ) {
    errors.push(err(path, `must be one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}`));
  }
  if (node.const !== undefined && !deepEqual(node.const, data)) {
    errors.push(err(path, `must be ${JSON.stringify(node.const)}`));
  }

  if (typeof data === 'string') {
    if (node.minLength !== undefined && data.length < node.minLength) {
      errors.push(err(path, `must be at least ${node.minLength} character(s) long`));
    }
    if (node.maxLength !== undefined && data.length > node.maxLength) {
      errors.push(err(path, `must be at most ${node.maxLength} character(s) long`));
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(data)) {
      errors.push(
        err(path, `${JSON.stringify(data)} does not match the required pattern ${node.pattern}`)
      );
    }
  }

  if (typeof data === 'number') {
    if (node.minimum !== undefined && data < node.minimum) {
      errors.push(err(path, `must be >= ${node.minimum} (got ${data})`));
    }
    if (node.maximum !== undefined && data > node.maximum) {
      errors.push(err(path, `must be <= ${node.maximum} (got ${data})`));
    }
  }

  if (Array.isArray(data)) {
    if (node.minItems !== undefined && data.length < node.minItems) {
      errors.push(err(path, `must contain at least ${node.minItems} item(s)`));
    }
    if (node.uniqueItems === true) {
      const seen = new Set(data.map((item) => JSON.stringify(item)));
      if (seen.size !== data.length) errors.push(err(path, 'must not contain duplicate entries'));
    }
    if (node.items !== undefined) {
      data.forEach((item, i) => errors.push(...check(item, node.items, `${path}[${i}]`, root)));
    }
  }

  if (isPlainObject(data)) {
    for (const key of node.required ?? []) {
      if (!(key in data)) errors.push(err(path, `is missing the required property "${key}"`));
    }
    const properties = node.properties ?? {};
    for (const [key, value] of Object.entries(data)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key in properties) {
        errors.push(...check(value, properties[key], childPath, root));
      } else if (node.additionalProperties === false) {
        errors.push(
          err(path, `has unknown property "${key}"${suggest(key, Object.keys(properties))}`)
        );
      } else if (node.additionalProperties !== undefined) {
        errors.push(...check(value, node.additionalProperties, childPath, root));
      }
    }
  }

  for (const sub of node.allOf ?? []) errors.push(...check(data, sub, path, root));

  if (node.anyOf !== undefined) {
    const branches = node.anyOf.map((/** @type {unknown} */ sub) => check(data, sub, path, root));
    if (branches.every((/** @type {SchemaError[]} */ b) => b.length > 0)) {
      errors.push(err(path, `did not match any allowed form: ${summariseBranches(branches)}`));
    }
  }

  if (node.oneOf !== undefined) {
    const branches = node.oneOf.map((/** @type {unknown} */ sub) => check(data, sub, path, root));
    const passing = branches.filter((/** @type {SchemaError[]} */ b) => b.length === 0).length;
    if (passing === 0) {
      errors.push(err(path, `did not match any allowed form: ${summariseBranches(branches)}`));
    } else if (passing > 1) {
      errors.push(err(path, 'matched more than one mutually exclusive form'));
    }
  }

  if (node.not !== undefined && check(data, node.not, path, root).length === 0) {
    errors.push(err(path, 'matched a forbidden form'));
  }

  if (node.if !== undefined) {
    const conditionHolds = check(data, node.if, path, root).length === 0;
    const branch = conditionHolds ? node.then : node.else;
    if (branch !== undefined) errors.push(...check(data, branch, path, root));
  }

  return errors;
}

/**
 * @param {string} ref
 * @param {object} root
 * @returns {unknown}
 */
function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Only local $ref values are supported, got ${JSON.stringify(ref)}`);
  }
  /** @type {any} */
  let node = root;
  for (const segment of ref.slice(2).split('/')) {
    node = node?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`Unresolvable $ref ${JSON.stringify(ref)} in schema`);
  }
  return node;
}

/**
 * @param {unknown} data
 * @param {string | string[]} type
 * @returns {boolean}
 */
function matchesType(data, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    switch (t) {
      case 'object':
        return isPlainObject(data);
      case 'array':
        return Array.isArray(data);
      case 'string':
        return typeof data === 'string';
      case 'boolean':
        return typeof data === 'boolean';
      case 'null':
        return data === null;
      case 'number':
        return typeof data === 'number' && Number.isFinite(data);
      case 'integer':
        return typeof data === 'number' && Number.isInteger(data);
      default:
        return false;
    }
  });
}

/**
 * @param {string | string[]} type
 * @returns {string}
 */
function describeType(type) {
  return Array.isArray(type) ? type.join(' or ') : type;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Offer the closest known property name, because 99% of "unknown property"
 * errors are a typo or a field put on the wrong check type.
 *
 * @param {string} key
 * @param {string[]} known
 * @returns {string}
 */
function suggest(key, known) {
  const lower = key.toLowerCase();
  const near = known.find(
    (candidate) =>
      candidate.toLowerCase() === lower ||
      candidate.toLowerCase().startsWith(lower.slice(0, 4)) ||
      lower.startsWith(candidate.toLowerCase().slice(0, 4))
  );
  return near ? ` (did you mean "${near}"?)` : '';
}

/**
 * @param {SchemaError[][]} branches
 * @returns {string}
 */
function summariseBranches(branches) {
  return branches.map((branch) => branch.map((e) => e.message).join('; ')).join(' | ');
}

/**
 * @param {string} path
 * @param {string} message
 * @returns {SchemaError}
 */
function err(path, message) {
  return { path: path || '(root)', message };
}
