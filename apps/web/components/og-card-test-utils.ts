import { isValidElement, type ReactElement, type ReactNode } from 'react';

type ElementSnapshot = {
  type: unknown;
  props: Record<string, unknown>;
};

export function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((child) => flattenText(child)).join('');
  }

  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    return flattenText(element.props.children);
  }

  return '';
}

export function collectElements(node: ReactNode): ElementSnapshot[] {
  if (!isValidElement(node)) {
    return [];
  }

  const element = node as ReactElement<{ children?: ReactNode }>;
  const children = element.props.children;
  const childElements = Array.isArray(children)
    ? children.flatMap((child) => collectElements(child))
    : collectElements(children);

  return [
    {
      type: element.type,
      props: element.props as Record<string, unknown>,
    },
    ...childElements,
  ];
}

