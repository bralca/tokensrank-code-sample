"use client";
import { useState } from 'react';
export function BuilderAvatar({ name, url }: { name: string; url?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return url && failedUrl !== url
    ? <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />
    : <span aria-hidden="true">{name.replace(/^@/, '').slice(0, 1).toUpperCase()}</span>;
}
