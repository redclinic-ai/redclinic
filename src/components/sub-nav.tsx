"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SubNav({ items }: { items: [string, string][] }) {
  const path = usePathname();
  const current = items.filter(([h]) => path === h || path.startsWith(h + "/")).sort((a, b) => b[0].length - a[0].length)[0]?.[0];
  return (
    <nav className="subnav" aria-label="Section">
      {items.map(([href, label]) => (
        <Link key={href} href={href} aria-current={href === current ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
  );
}
