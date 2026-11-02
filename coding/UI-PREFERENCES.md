# CodeCrew UI and project preferences

These are the user's defaults for substantial interface work and new-project stack choices. Current task instructions, the existing project's stack and established brand take precedence. Apply the relevant sections; this is not an instruction to migrate an existing application or install every listed library. Small copy, icon, spacing and similarly exact edits keep the direct workflow.

## Visual reference before implementation

Design mobile first. Before coding a substantial new interface or redesign, inspect the product, real content, existing components and assets, then create a viewable visual reference for the primary mobile screen and its desktop adaptation. Use an available image-generation or design tool; reuse a supplied design when it covers the brief. When those tools are unavailable, create an editable SVG or comparable local visual concept and state that limitation. A prose plan alone does not satisfy this phase.

Save references separately from shipping assets and inspect them before implementation. For long landing pages, make the section sequence and imagery readable in separate reference views. Record the chosen direction and reference paths in the workspace brief or coordinator checkpoint. Continue into code without an extra confirmation round unless the user requests approval or a consequential ambiguity remains. Rebuild text, controls and layout as real components; a screenshot is a reference, not the finished UI.

## Hierarchy, typography and layout

Put the most important information and primary action first. Operational panels should be compact, clear and easy to scan: show status, blockers and the next useful action before secondary detail. Use deliberate grouping, aligned labels, consistent spacing and progressive disclosure. Density comes from efficient layout, not tiny text or cramped controls.

Choose fonts deliberately for the product and language. Check real glyph coverage and RTL where needed; use a suitable UI family, with a complementary display face only when useful. Keep a coherent type scale, readable line heights and line lengths, restrained weights, and tabular numerals for comparable metrics. Start with 14–16px panel body text, 16px mobile inputs and 12–14px secondary labels; verify actual rendered legibility and text zoom rather than treating these as universal limits. Maintain good contrast, including muted text, badges, placeholders and interaction states.

Design the narrow layout first, then expand through tablet and desktop. Use a spacing scale for padding, margin and gaps; allow flex/grid children to shrink and long content to wrap. Check 390px mobile, an intermediate width and 1440px desktop, plus relevant touch, keyboard, empty, loading, error and disabled states. Fix overflow at its source rather than clipping the page. Use responsive detail panels and controls with comfortable touch targets; simplify dense mobile tables without losing access to their information.

Prefer border-light surfaces and component styling over browser-default outlines and visible scrollbar chrome. Preserve a clearly visible keyboard focus state using suitable background, shadow or other designed feedback; retain a usable forced-colors treatment. Keep scrolling, touch gestures and keyboard navigation functional when hiding scrollbar chrome, and make scrollable content discoverable. Style controls through accessible component libraries while retaining semantic buttons, links, inputs and labels underneath.

## Components, icons and motion

Use Phosphor icons with a consistent family, weight and optical size. Replace another icon set in newly adopted component source where practical; label icon-only actions accessibly. Prefer established styled components over unstyled browser widgets or custom reimplementations.

Consider the user's preferred sources before building visual effects from scratch:

- [React Bits](https://reactbits.dev/get-started/index) for selected visual components and effects.
- [Lightswind UI](https://lightswind.com/components/introduction) for selected professional and animated components alongside the existing design system.
- [dqnamo Receipt Printer](https://www.dqnamo.com/experiments/receipt-printer) as a tactile interaction and micro-animation reference, not an assumed installable component library.

Use current official documentation to choose only relevant components and dependencies. Inspect their accessibility, mobile behavior, source, assets and usage terms; use available free components or already licensed material. Similar libraries are welcome when they fit the visual direction and reduce implementation work. Keep the product coherent rather than assembling unrelated effects.

Use micro-animation for feedback and orientation. Prefer GSAP for deliberate timeline and scroll choreography, Three.js for useful 3D scenes, and Lenis for suitable smooth scrolling. Load them only where needed, clean up effects and listeners, and respect reduced motion. Landing pages may use cinematic scroll with imagery and a clear narrative; panels should keep actions immediate. Preserve ordinary navigation and a readable experience on touch devices and when motion or 3D is unavailable.

## Landing pages and images

Prefer substantial, content-rich landing pages with many purposeful sections and plentiful relevant imagery, organized around the audience and primary action. Establish a strong visual direction with real content, varied but consistent composition, and a deliberate type and spacing system. Avoid generic template repetition, filler sections, invented testimonials or metrics, and decorative effects with no product purpose.

Use supplied, generated or appropriately licensed images with intentional art direction and consistent crops. Export photographic shipping assets as WebP at quality 70, sized for their rendered use. Provide responsive sizes, dimensions and meaningful alternative text. Prioritize the main hero image and defer below-the-fold media; keep sharp vectors such as icons as vectors.

## Default application stack

| Concern | Preferred choice |
| --- | --- |
| Web application | Next.js with TypeScript, Tailwind CSS and shadcn/ui |
| Runtime and package manager | Latest stable Bun; `packageManager: "bun@latest"`; retain the application lockfile |
| Runtime capabilities | Prefer Bun's native APIs when they cover the requirement; verify current behavior before adding an equivalent package |
| Relational database | PostgreSQL |
| Object storage | Garage through its S3-compatible API; keep credentials server-side and validate the specific operations needed |
| Authentication | Better Auth for application-owned authentication; Clerk for a managed service when chosen or already in use; use one coherent auth system per application |
| Data tables | TanStack Table with server-side pagination, sorting and filtering; preserve server authorization and useful loading/empty/error states |
| Navigation | Next.js internal navigation links with `prefetch={true}` for full prefetch according to the installed version; verify in a production build |
| Production container | A production Dockerfile compatible with Docker or Podman, using stable Bun, dependency/build caching and security-conscious runtime settings |

Read the installed version's documentation before implementation. Preserve existing contracts and dependencies when extending a project. Bun-native APIs are a preference for covered capabilities, not a reason to replace required framework adapters or working libraries. PostgreSQL, Garage and auth infrastructure are added only when the application needs them.

Full prefetch is for read-only navigation. Keep mutations and sign-out actions explicit, protect user-specific data and cache boundaries, and check real production navigation behavior. Prefer server rendering and the existing data layer; add client fetching tools only for a concrete interaction requirement.

For Bun production containers, use `oven/bun:latest` or its stable latest Alpine/slim variant, frozen-lockfile installs, separate build/runtime stages where useful, and cache dependency steps independently from source changes. Run with a non-root user, minimal production files and dependencies, runtime-provided secrets and appropriate health checks. Cache public/static assets deliberately while preserving private/authenticated data semantics. Verify the actual Next.js build, Bun runtime and container startup before claiming production readiness.
