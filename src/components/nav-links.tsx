"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import type { NavItem } from "@/lib/nav";

function active(path: string, href: string) {
  return path === href || (href !== "/home" && path.startsWith(href + "/")) || (href === "/admin" && path === "/admin");
}

export function SideNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="sidenav" aria-label="Main">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className="nav-link" aria-current={active(path, i.href) ? "page" : undefined}>
          <Icon name={i.icon} /> <span>{i.label}</span>
        </Link>
      ))}
    </nav>
  );
}

/** Phone: up to four main items along the bottom, the rest under "More". */
export function BottomNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  const primary = items.filter((i) => i.primary).slice(0, 4);
  const rest = items.filter((i) => !primary.includes(i));
  return (
    <nav className="bottomnav" aria-label="Main">
      {primary.map((i) => (
        <Link key={i.href} href={i.href} className="bn-link" aria-current={active(path, i.href) ? "page" : undefined}>
          <Icon name={i.icon} size={22} /><span>{i.label === "Needs attention" ? "Attention" : i.label}</span>
        </Link>
      ))}
      {rest.length > 0 && (
        <details className="bn-more">
          <summary className="bn-link"><Icon name="more" size={22} /><span>More</span></summary>
          <div className="bn-sheet">
            {rest.map((i) => (
              <Link key={i.href} href={i.href} className="nav-link" aria-current={active(path, i.href) ? "page" : undefined}>
                <Icon name={i.icon} /> <span>{i.label}</span>
              </Link>
            ))}
          </div>
        </details>
      )}
    </nav>
  );
}
