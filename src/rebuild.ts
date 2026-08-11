/**
 * A rebuild that a deploy cannot kill.
 *
 * Compiles run on the cron deployment, which the platform schedules and which a deploy
 * does not land on mid-flight. The read-triggered rebuild that used to live here is
 * **removed**: loading a Persona still compares its version against the compiler's, still
 * tightens the gate, and still withholds prose written under moved rules — on that read,
 * with no wait — but it no longer queues or starts a rebuild.
 *
 * At most one Compile is in flight per Persona, enforced by the database's `running`
 * row rather than by process-local state, so two concurrent schedulers cannot
 * double-compile.
 *
 * Cadence is daily and there is exactly one trigger path: the scheduled job.
 * A Persona serves behind the compiler for up to a day after a rules change, by design.
 *
 * See docs/design/compiler.md §3 and docs/design/deployment.md §2.
 */
