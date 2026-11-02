import { z } from 'zod';
import { SCOPE_TIERS } from './tasks';

// The optional Backrooms game profile (spec §19). It does not assume every system belongs in the game: each domain starts unconfirmed,
// shows what the project's files suggest (a hint, never proof), and becomes a subsystem for tasks only after the person confirms it.
// It keeps the long-term dream, the prototype, the vertical slice and the release apart (the milestone scope tiers of Step 10), asks
// the horror-quality questions together, and flags the features that most often sink an indie schedule.

export const BACKROOMS_DOMAINS = [
  { id: 'movement', label: 'Player movement and interaction', keywords: ['movement', 'character', 'player', 'interact', 'pawn'] },
  { id: 'camera', label: 'Camera and first-person presentation', keywords: ['camera', 'firstperson', 'viewmodel', 'fpv'] },
  { id: 'level', label: 'Level layout and environment art', keywords: ['level', 'map', 'environment', 'room', 'hall', 'corridor'] },
  { id: 'lighting', label: 'Lighting, fog, materials and post-processing', keywords: ['light', 'fog', 'material', 'postprocess', 'lumen'] },
  { id: 'audio', label: 'Player audio and environmental sound', keywords: ['audio', 'sound', 'metasound', 'ambience', 'music'] },
  { id: 'enemy', label: 'Enemy behavior and AI', keywords: ['enemy', 'monster', 'stalker', 'ai', 'behaviortree', 'entity'] },
  { id: 'navigation', label: 'Navigation and detection', keywords: ['navigation', 'navmesh', 'perception', 'detect', 'sight'] },
  { id: 'pursuit', label: 'Hiding, pursuit and escape gameplay', keywords: ['hide', 'hiding', 'chase', 'pursuit', 'escape', 'locker'] },
  { id: 'progression', label: 'Objectives and progression', keywords: ['objective', 'quest', 'progress', 'mission', 'checkpoint'] },
  { id: 'puzzles', label: 'Puzzles and interactive objects', keywords: ['puzzle', 'door', 'key', 'switch', 'lever', 'pickup'] },
  { id: 'procedural', label: 'Procedural generation', keywords: ['procedural', 'proc', 'generator', 'generation', 'pcg', 'wavefunction'] },
  { id: 'multiplayer', label: 'Multiplayer and networking', keywords: ['multiplayer', 'network', 'replicat', 'onlinesubsystem', 'session', 'lobby'] },
  { id: 'save', label: 'Save/load and configuration', keywords: ['save', 'load', 'config', 'settings', 'savegame'] },
  { id: 'ui', label: 'UI and accessibility', keywords: ['ui', 'hud', 'widget', 'menu', 'umg', 'accessib'] },
  { id: 'performance', label: 'Performance and scalability', keywords: ['performance', 'scalab', 'lod', 'stat', 'profil'] },
  { id: 'optimization', label: 'Asset optimization', keywords: ['optimi', 'lod', 'nanite', 'texture', 'compress'] },
  { id: 'packaging', label: 'Packaging and distribution', keywords: ['package', 'packaging', 'build', 'release', 'steam', 'distribution'] },
] as const;
export type BackroomsDomainId = (typeof BACKROOMS_DOMAINS)[number]['id'];
export const DOMAIN_IDS = BACKROOMS_DOMAINS.map((d) => d.id) as [BackroomsDomainId, ...BackroomsDomainId[]];

/** The qualities that make the environment work, considered together rather than as a polygon count (spec §19). */
export const HORROR_CHECKLIST = [
  { id: 'lighting', label: 'Lighting', question: 'Does the light create the mood and guide the eye, or only illuminate?' },
  { id: 'composition', label: 'Composition', question: 'Do the spaces and sightlines frame what the player should notice and fear?' },
  { id: 'materials', label: 'Materials', question: 'Is there enough variation and wear to feel real without costing more than it adds?' },
  { id: 'sound', label: 'Sound', question: 'Does sound carry the dread, including silence and what the player cannot see?' },
  { id: 'layout', label: 'Layout', question: 'Is the space readable enough to be lost in on purpose, not by accident?' },
  { id: 'pacing', label: 'Pacing', question: 'Does tension rise and fall, with moments to breathe?' },
  { id: 'atmosphere', label: 'Atmosphere', question: 'Do fog, color, details and scale add up to one feeling?' },
  { id: 'performance', label: 'Performance', question: 'Does it hold its frame rate where the player is most afraid?' },
] as const;
export type ChecklistId = (typeof HORROR_CHECKLIST)[number]['id'];
export const CHECKLIST_IDS = HORROR_CHECKLIST.map((c) => c.id) as [ChecklistId, ...ChecklistId[]];

export const ProfileViewSchema = z.object({
  enabled: z.boolean(),
  domains: z.array(
    z.object({
      id: z.enum(DOMAIN_IDS),
      label: z.string().max(100),
      confirmed: z.boolean(),
      /** What in the project's files suggests this system exists. A hint to check, not a finding. */
      hints: z.array(z.string().max(200)).max(6),
    }),
  ),
  checklist: z.array(z.object({ id: z.enum(CHECKLIST_IDS), label: z.string().max(40), question: z.string().max(200), checked: z.boolean() })),
  /** Features that threaten the budget or timeline of an indie project, from what was confirmed. */
  flags: z.array(z.object({ id: z.string().max(40), title: z.string().max(120), detail: z.string().max(500) })).max(6),
  /** Milestones per scope tier: the dream, the first prototype, the vertical slice and the release, kept apart. */
  tiers: z.array(z.object({ tier: z.enum(SCOPE_TIERS), milestones: z.number().int().nonnegative() })),
  note: z.string().max(400),
});
export type ProfileView = z.output<typeof ProfileViewSchema>;

export const ProfilePatchSchema = z.strictObject({
  projectId: z.string().max(64),
  enabled: z.boolean().optional(),
  /** The domains you confirmed against the real design; replaces the list. */
  confirmedDomains: z.array(z.enum(DOMAIN_IDS)).max(20).optional(),
  /** The checklist items you ticked; replaces the list. */
  checked: z.array(z.enum(CHECKLIST_IDS)).max(10).optional(),
});
