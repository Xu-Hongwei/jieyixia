// 紧凑的 JSON-Schema 子集校验器，直接驱动权威契约 schema.json（单一来源，不手写镜像结构）。
// 双来源：活契约 0.6.0（@contract）与冻结 0.4.0（@frozen-040，v1 旧备份专用，字节不变）。
// 只实现契约生成物实际用到的关键字：$ref/type/enum/const/properties/required/
// additionalProperties:false/items/anyOf/oneOf/if-then/minItems/maxItems/minLength/maxLength/
// minimum/maximum/exclusiveMinimum/exclusiveMaximum；注解 default/title/description 忽略。
// 结构/类型/枚举/未知字段/数组与字符串边界由此把关；真实时间/版本/关系等 model_validator 语义在 validate.js 补充。
import schema from '@contract/schema.json'
import frozen040Schema from '@frozen-040/schema.json'

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string'
    case 'boolean': return typeof v === 'boolean'
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'array': return Array.isArray(v)
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v)
    case 'null': return v === null
    default: return true
  }
}

const eq = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)

// 校验器工厂：node/resolveRef 闭包绑定各自的 $defs，活契约与冻结契约互不串用。
function makeValidator(defs) {
  function resolveRef(ref) {
    const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref)
    if (!m || !defs[m[1]]) throw new Error(`无法解析 schema $ref：${ref}`)
    return defs[m[1]]
  }

  // 把 value 对照 schema 节点校验，错误推入 errors（带路径）。返回是否通过。
  function node(schemaNode, value, path, errors) {
    if (!schemaNode || typeof schemaNode !== 'object') return true
    let s = schemaNode
    if (s.$ref) s = { ...resolveRef(s.$ref), ...stripRef(s) }

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type]
      if (!types.some((t) => typeOk(t, value))) {
        errors.push({ path, message: `类型应为 ${types.join('|')}，实际 ${typeName(value)}` })
        return false
      }
    }
    if (s.enum !== undefined && !s.enum.some((e) => eq(e, value))) {
      errors.push({ path, message: `值必须是枚举之一：${JSON.stringify(s.enum)}` })
    }
    if (s.const !== undefined && !eq(s.const, value)) {
      errors.push({ path, message: `值必须等于 ${JSON.stringify(s.const)}` })
    }
    if (s.anyOf !== undefined) {
      const ok = s.anyOf.some((branch) => {
        const tmp = []
        node(branch, value, path, tmp)
        return tmp.length === 0
      })
      if (!ok) errors.push({ path, message: '值不满足 anyOf 任一分支（含可空类型）' })
    }
    if (s.oneOf !== undefined) {
      const ok = s.oneOf.some((branch) => {
        const tmp = []
        node(branch, value, path, tmp)
        return tmp.length === 0
      })
      if (!ok) errors.push({ path, message: '值不满足 oneOf 任一分支（判别联合）' })
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) errors.push({ path, message: `数组至少 ${s.minItems} 项，实际 ${value.length}` })
      if (s.maxItems !== undefined && value.length > s.maxItems) errors.push({ path, message: `数组最多 ${s.maxItems} 项，实际 ${value.length}` })
      if (s.items !== undefined) value.forEach((el, i) => node(s.items, el, `${path}[${i}]`, errors))
    }
    if (typeof value === 'string') {
      if (s.minLength !== undefined && value.length < s.minLength) errors.push({ path, message: `字符串至少 ${s.minLength} 字，实际 ${value.length}` })
      if (s.maxLength !== undefined && value.length > s.maxLength) errors.push({ path, message: `字符串最多 ${s.maxLength} 字，实际 ${value.length}` })
    }
    if (typeof value === 'number') {
      if (s.minimum !== undefined && value < s.minimum) errors.push({ path, message: `数值不得小于 ${s.minimum}` })
      if (s.maximum !== undefined && value > s.maximum) errors.push({ path, message: `数值不得大于 ${s.maximum}` })
      if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push({ path, message: `数值必须大于 ${s.exclusiveMinimum}` })
      if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum) errors.push({ path, message: `数值必须小于 ${s.exclusiveMaximum}` })
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const props = s.properties || {}
      if (Array.isArray(s.required)) {
        for (const key of s.required) {
          if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
            errors.push({ path: `${path}.${key}`, message: `缺少必需字段 ${key}` })
          }
        }
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(props, key)) {
            errors.push({ path: `${path}.${key}`, message: `未知字段 ${key}（契约 additionalProperties:false）` })
          }
        }
      }
      for (const key of Object.keys(value)) {
        if (props[key] !== undefined && value[key] !== undefined) node(props[key], value[key], `${path}.${key}`, errors)
      }
    }
    if (s.if !== undefined) {
      const tmp = []
      node(s.if, value, path, tmp)
      if (tmp.length === 0 && s.then !== undefined) node(s.then, value, path, errors)
      if (tmp.length > 0 && s.else !== undefined) node(s.else, value, path, errors)
    }
    return errors.length === 0
  }

  return function validate(defName, value) {
    if (!defs[defName]) throw new Error(`契约 schema 无定义：${defName}`)
    const errors = []
    node(defs[defName], value, defName, errors)
    return { ok: errors.length === 0, errors }
  }
}

// $ref 的兄弟关键字这里只有注解；保留非注解关键字以兼容未来扩展。
function stripRef(s) {
  const out = {}
  for (const k of Object.keys(s)) if (k !== '$ref' && k !== 'default' && k !== 'title' && k !== 'description') out[k] = s[k]
  return out
}

function typeName(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

const liveValidate = makeValidator(schema.$defs)
const frozen040Validate = makeValidator(frozen040Schema.$defs)

// 对照具名契约定义校验业务核心对象（活契约 0.5.0）。返回 { ok, errors:[{path,message}] }。
export function validateAgainstDef(defName, value) {
  return liveValidate(defName, value)
}

// v1/0.4.0 旧备份专用：只认冻结 schema，不随活契约升级。
export function validateAgainstFrozen040Def(defName, value) {
  return frozen040Validate(defName, value)
}

export const CONTRACT_SCHEMA_VERSION = schema.schema_version
export const CONTRACT_DEFS = Object.keys(schema.$defs)
export const FROZEN_040_SCHEMA_VERSION = frozen040Schema.schema_version
export const FROZEN_040_DEFS = Object.keys(frozen040Schema.$defs)