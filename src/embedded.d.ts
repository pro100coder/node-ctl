// Files imported with { type: 'text' } are their contents, compiled into the binary.
declare module '*.tf' {
  const text: string;
  export default text;
}
declare module '*.hcl' {
  const text: string;
  export default text;
}
declare module '*.sh' {
  const text: string;
  export default text;
}
declare module '*.md' {
  const text: string;
  export default text;
}
declare module '*.yaml' {
  const text: string;
  export default text;
}
