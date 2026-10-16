# Internext POS homepage refresh

## Design plan

- Audience: restaurant owners evaluating the product and staff returning to the counter. Primary navigation must make staff access immediate; training is separate and explicit.
- Palette: ink navy #122b49, action blue #1559d6, white #ffffff, work-surface blue #edf3fa, muted text #506176, verified-state green #17634b. Real food photography supplies warmth.
- Type: local system humanist sans stack (Segoe UI, system-ui, sans-serif), no network font. Headline 62/65 desktop, 40/43 mobile; section titles32/36; body16/26; minimum important labels12/18.
- Layout: quiet masthead, left-aligned headline and two distinct destinations, a substantial counter/menu illustration with authentic three-dish photos; operational sequence follows, then an availability matrix, planned growth features and a single subscription panel.

```text
Desktop: [brand | workflow pricing | staff]
         [headline + destinations | menu + receipt illustration]
         [first order -> take payment -> close shift]
         [what works now | availability matrix]
         [offers planned       | Android/offline + branches planned]
         [one branch plan      | US$100 and billing status]
Mobile:  [brand | staff] / [workflow pricing training]
         headline -> destinations -> menu illustration
         sequence -> status rows -> roadmap -> pricing
```

## Review before implementation

The earlier homepage led with a training preview and outdated AED100 price. A generic feature-card grid obscured the operational difference between online sales and training-only tools. This refresh makes that distinction visible in a compact availability matrix and uses a menu/receipt composition specific to restaurant service. Avoid invented sales totals, reviews, customer counts, live badges, active checkout claims, stock photography or unsupported AI claims. Offers, Android offline sales and recurring PayPal remain explicitly planned/in development. US$100 per branch/month covers multiple devices and all product features as released.

## Verification

Pending rendered desktop and375px CUA inspection after preview is available. No deployment performed by design specialist.

### Implementation handoff

Implemented the dedicated marketing page and stylesheet. The page overrides its own title/description/social description with US$100 pricing. Root must update the shared layout metadata separately. Primary CTA goes to `/counter`, training to `/pos`, subscription details to `/billing` (billing implementation is owned by another agent).

Scoped ESLint completed: zero errors, one advisory for ordinary `<img>` elements. The three assets are local, already-compressed WebP photographs with explicit intrinsic dimensions; no external font or image requests were introduced. No app state or business logic changed.

Rendered verification is **pending**. The available server on3045 served the previous build, so it was not accepted as evidence for this change. Root requested a handoff before the new preview build to free the specialist slot. A separate Chrome review tab was created; in-app browser was unavailable. No desktop/mobile pass claimed and no deployment performed.
