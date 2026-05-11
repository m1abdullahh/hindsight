// Simplified toast store inspired by shadcn/ui's reducer-based hook.
import * as React from 'react';

import type { ToastActionElement } from './toast';

const TOAST_LIMIT = 3;
const TOAST_REMOVE_DELAY = 5_000;

type ToastVariant = 'default' | 'destructive';

interface ToasterToast {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  open?: boolean;
  variant?: ToastVariant;
  onOpenChange?: (open: boolean) => void;
}

let count = 0;
const genId = (): string => {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
};

type Action =
  | { type: 'ADD'; toast: ToasterToast }
  | { type: 'UPDATE'; toast: Partial<ToasterToast> & { id: string } }
  | { type: 'DISMISS'; id?: string }
  | { type: 'REMOVE'; id?: string };

interface State {
  toasts: ToasterToast[];
}

const removeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const queueRemoval = (id: string): void => {
  if (removeTimeouts.has(id)) return;
  const timeout = setTimeout(() => {
    removeTimeouts.delete(id);
    dispatch({ type: 'REMOVE', id });
  }, TOAST_REMOVE_DELAY);
  removeTimeouts.set(id, timeout);
};

const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD':
      return { toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT) };
    case 'UPDATE':
      return {
        toasts: state.toasts.map((t) => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      };
    case 'DISMISS': {
      if (action.id) {
        queueRemoval(action.id);
      } else {
        state.toasts.forEach((t) => queueRemoval(t.id));
      }
      return {
        toasts: state.toasts.map((t) =>
          t.id === action.id || action.id === undefined ? { ...t, open: false } : t,
        ),
      };
    }
    case 'REMOVE':
      if (action.id === undefined) return { toasts: [] };
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
  }
};

const listeners: ((state: State) => void)[] = [];
let memoryState: State = { toasts: [] };

const dispatch = (action: Action): void => {
  memoryState = reducer(memoryState, action);
  listeners.forEach((l) => l(memoryState));
};

interface ToastInput {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  action?: ToastActionElement;
}

export const toast = (input: ToastInput) => {
  const id = genId();
  const update = (next: Partial<ToasterToast>) =>
    dispatch({ type: 'UPDATE', toast: { ...next, id } });
  const dismiss = () => dispatch({ type: 'DISMISS', id });

  dispatch({
    type: 'ADD',
    toast: {
      ...input,
      id,
      open: true,
      onOpenChange: (open: boolean) => {
        if (!open) dismiss();
      },
    },
  });

  return { id, update, dismiss };
};

export const useToast = () => {
  const [state, setState] = React.useState<State>(memoryState);
  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const idx = listeners.indexOf(setState);
      if (idx > -1) listeners.splice(idx, 1);
    };
  }, []);
  return {
    ...state,
    toast,
    dismiss: (id?: string) =>
      dispatch(id !== undefined ? { type: 'DISMISS', id } : { type: 'DISMISS' }),
  };
};
