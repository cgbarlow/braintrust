/**
 * The probe set: questions whose answer braintrust already knows, used to find where a
 * Corpus stops answering.
 *
 * A probe is **not** a test of whether the retrieval is any good. It is a pair of groups —
 * questions this Person demonstrably covers, and questions nobody could think they cover —
 * measured so that the gap between the groups can be seen. `SELECTIVITY_MARGIN` goes in
 * that gap. If there is no gap, the endpoint cannot tell the two apart and no threshold
 * exists that would help, which is a finding rather than a failure to find one.
 *
 * **The `out` questions are shared across everyone, deliberately.** They are off-corpus for
 * any commentator on AI and work, so the same set measures a thin Corpus and a thick one
 * without introducing a second variable. They are also mundane on purpose: a question about
 * a rival technology would be genuinely near the Corpus and would measure something else.
 *
 * **The `in` questions must be per Person, and must be answerable from what braintrust
 * actually read** rather than from what the person is famous for. A question about a
 * paywalled post is off-corpus for braintrust however central it is to the person.
 */

export type ProbeSet = {
  /** Off-corpus for every Person here. Run against each of them. */
  out: string[];
  /** In-corpus, per Person slug. */
  people: Record<string, string[]>;
};

/**
 * The set braintrust ships, covering the two reference Personas that map #105 named: a
 * thin Corpus and a thick one. #115 found the counterfeit-licence failure is specific to
 * thin Corpora — on 19 items the most central Positions are also the best evidenced — so a
 * threshold measured only against the thick one would be measured against the easy case.
 *
 * An operator following anyone else should add their own `in` list and re-run. The `out`
 * list travels unchanged.
 */
export const DEFAULT_PROBES: ProbeSet = {
  out: [
    'the correct water temperature for poaching an egg',
    'how to prune tomato plants so they fruit better',
    'what the offside rule is in football',
    'how to replace the inner tube on a bicycle wheel',
    'which key Beethoven’s fifth symphony is written in',
    'how long to leave bread dough to prove',
    'the best way to get a wine stain out of a carpet',
    'what causes the tides',
  ],
  people: {
    'ethan-mollick': [
      'what AI agents change about how work actually gets done',
      'how someone should choose which AI model to pay for',
      'what AI does to how students learn and how they are assessed',
      'whether AI makes people more productive at real jobs',
      'what happens to entry-level work as AI gets better',
      'how good AI has got at building working software from a prompt',
      'the risks of giving an AI broad access to your computer',
    ],
    'nate-b-jones': [
      'what AI agents change about how work actually gets done',
      'how to think about which AI model to use for a task',
      'what the latest model releases mean for people building products',
      'how AI changes what a product manager does day to day',
      'whether AI coding tools actually make engineers faster',
      'what makes an AI product defensible',
      'how to keep up with the pace of AI releases',
    ],
  },
};
