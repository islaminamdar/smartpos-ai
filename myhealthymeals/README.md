# MyHealthyMeals.ae — Redesign

Clean, modern redesign (Direction B) of the MyHealthyMeals Dubai meal subscription site.

## Tech stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Plus Jakarta Sans
- Lucide icons

## Pages

| Route      | Description                                                      |
| ---------- | ---------------------------------------------------------------- |
| `/`        | Homepage with hero, plans, menu preview, pricing, FAQ, lead form |
| `/plans`   | All 8 dietitian-built meal plans                                 |
| `/pricing` | Monthly/weekly pricing tiers with comparison table               |
| `/menu`    | Filterable meal grid with expandable nutrition                   |
| `/quiz`    | 4-step plan recommendation quiz → WhatsApp                       |

## Development

```bash
cd myhealthymeals
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Design system

- **Primary:** `#16a34a` (brand green)
- **Surfaces:** Zinc gray scale
- **Typography:** Plus Jakarta Sans (single sans family)
- **Patterns:** Rounded cards, pill CTAs, sticky mobile quiz bar

## WhatsApp integration

Lead form and quiz build `wa.me` URLs with pre-filled messages. Update the phone number in `lib/site.ts`.
