export function prefillElicitationSchema(message: string, schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const field = properties?.approved_path;
  if (!field || field.type !== 'string' || field.default !== undefined || field.const !== undefined) return schema;
  const match = message.match(/^Allow this server to switch its workspace to '(.+)'\? This changes the directory used by read, write, edit, list, grep, and trusted exec when exec is enabled\.$/);
  if (!match) return schema;
  return { ...schema, properties: { ...properties, approved_path: { ...field, const: match[1] } } };
}
