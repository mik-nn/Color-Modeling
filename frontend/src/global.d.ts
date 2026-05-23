declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}

declare module 'pako' {
  export function inflate(data: Uint8Array | ArrayBuffer): Uint8Array
  export function deflate(data: Uint8Array | ArrayBuffer): Uint8Array
}

declare module 'react-dom/client' {
  export type Root = {
    render: (node: unknown) => void
    unmount: () => void
  }

  export function createRoot(
    container: Element | DocumentFragment | null
  ): Root
}

declare module 'react/jsx-runtime' {
  export const Fragment: unknown
  export const jsx: unknown
  export const jsxs: unknown
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: Record<string, unknown>
  }
}
