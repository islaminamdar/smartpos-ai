# Temporary menu illustrations — 17 October 2026

The user approved clearly labelled temporary illustrations for the eight catalogue entries without photographs. Seven AI-generated illustrations now provide display-only fallbacks for these exact Bur Dubai product IDs. They are **not photographs of the restaurant's food** and do not verify serving size, ingredients or appearance. The existing 125 source photographs retain priority.

| Archived item                 | Product UUID                         | Illustration asset      |
| ----------------------------- | ------------------------------------ | ----------------------- |
| I631882169A — SAMOSA PAV      | dc0f1421-33f2-55a5-bf17-eee5d3236d7c | samosa-pav.webp         |
| I329384297A — VADA PAV        | 1173eed3-edfc-5a34-b175-0b7195bc4ddc | vada-pav.webp           |
| I070883924A — Matka lassi     | 2268550f-c55a-554e-aca9-98e7d028f527 | matka-lassi.webp        |
| I545759684A — Matka Lassi     | 86d5608e-ee87-58c4-9672-452e7978aea9 | matka-lassi.webp        |
| I206529090A — TOAST           | 664ee15d-c27f-5245-8eb8-05cd51219c7d | toast.webp              |
| I353644836A — Kismis Aflatoon | 8d2bd971-1143-59ac-a7d6-d05229767839 | kismis-aflatoon.webp    |
| I388674014A — Maska butter    | 8c6e9ad1-7f2a-52b2-9fb5-c9511ede345d | bakery-placeholder.webp |
| I709334254A — Meal            | 41c1e2ae-ceb8-565d-b658-b4e0303e4a8f | meal-placeholder.webp   |

Assets live under `public/pos-assets/menu-illustrations`. The mapping is restricted to branch `79d4b844-1fd4-4cdf-a32f-db9329d75f3a`, not dish-name matching. Both Matka Lassi records remain separate. TOAST and Kismis Aflatoon remain unpriced and unavailable. No catalogue/database records, archived source files, prices or availability are changed.

The counter and manager's photo editor display **Temporary illustration** beside each fallback, with descriptive alternative text identifying it as an illustration. Any actual `imageUrl` suppresses the fallback, including a newly uploaded unsaved photo. Saving an actual photograph through the existing manager controls replaces the fallback naturally. The illustration is never submitted as the catalogue's photo URL.

Maska butter's exact bakery identity and the Meal's dishes/portion are still unconfirmed. Their assets are explicitly generic symbols: a bakery basket and a covered serving dish. They must not be treated as evidence of what is supplied.

## Generation provenance

Tool: OpenAI image generation, 17 October 2026. Every output was visually inspected before optimization. Outputs were square 1254 × 1254 PNGs, then resized to 512 × 512 WebP at quality 82 using Sharp; each final image is below 50 KB. The companion [provenance manifest](../../public/pos-assets/menu-illustrations/provenance.json) records the exact source filenames, original/final SHA-256 hashes, output dimensions and byte sizes. It preserves the distinction from archived Noon photographs.

Exact common generation prompt:

> Create one square 512x512 menu tile illustration, a clearly hand-painted flat gouache food illustration, not a photograph or photorealistic render. Warm ivory background, clean centered subject, softly drawn charcoal outlines, subtle pink accent, generous 15% margin, no text, no logo, no watermark, no people. This is a temporary visual for a restaurant POS and must look visibly illustrated, not a claim of actual serving.

The subject instructions below are summaries retained from generation, not verbatim prompts:

- Samosa pav: triangular samosa in a soft split pav bun.
- Vada pav: potato fritter in pav with a little green chutney.
- Matka lassi: terracotta pot of white lassi, without toppings.
- Toast: two golden crisp rusk/toast slices on a plate.
- Kismis Aflatoon: golden-brown generic Indian raisin sweet pieces.
- Bakery placeholder: generic basket and napkin with baked shapes; do not depict dairy butter or claim a specific Maska butter product.
- Meal placeholder: covered cloche, empty plate, spoon and fork; no specific dishes, ingredients or portions.

## Remaining real-photo work

Collect photographs of the actual seven dish names, confirm Maska butter's identity and the Meal's contents, then attach the photographs to the eight records. Temporary illustration coverage does not count as verified restaurant-photo coverage.
