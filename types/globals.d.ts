// Types the code shares that JSDoc cannot declare. Type-checking only: this folder does not ship.

declare global {
  // Set in the page by the REPL's page-side functions.
  interface Window {
    __pwReplListenersOf?: Element;
  }

  // An Error with the fields the REPL adds: uncertain when input may have reached the page.
  interface PwError extends Error {
    uncertain?: boolean;
  }
}

// Undocumented, but kept by Node's readline: the lines typed, newest first.
declare module 'readline' {
  interface Interface {
    history: string[];
  }
}

export {};
