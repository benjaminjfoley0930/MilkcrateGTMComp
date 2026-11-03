import { SubNav } from "@/components/ui";

export function CompanyNav({ slug, active }: { slug: string; active: "close" | "plan" | "data" | "questions" }) {
  const items = [
    { href: `/ops/${slug}`, label: "Close" },
    { href: `/ops/${slug}/plan`, label: "Plan" },
    { href: `/ops/${slug}/data`, label: "Roster and data" },
    { href: `/ops/${slug}/questions`, label: "Rep questions" },
  ];
  const map = { close: items[0].href, plan: items[1].href, data: items[2].href, questions: items[3].href };
  return <SubNav items={items} active={map[active]} />;
}
