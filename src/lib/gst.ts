// GST / BAS (#137) — pure, deterministic helpers for an INDICATIVE BAS workpaper. NO I/O.
// GENERAL INFO ONLY — Quillo never lodges a BAS; lodgement + adjustments are defer-to-agent.
//
// Australian GST is 1/11th of a GST-inclusive taxable supply (10% on the ex-GST price). Output tax is
// what you collected on sales; input tax credits are the GST on your business purchases; the net BAS
// position is output − input (positive = you owe the ATO; negative = a refund). GST is NOT income tax —
// its net never touches the income-tax position.

/** GST contained in a GST-inclusive amount: round(amount / 11). Floors negatives at 0. */
export function gstFromInclusiveCents(inclusiveCents: number): number {
  return Math.round(Math.max(0, inclusiveCents) / 11);
}

export interface BasNet {
  output_gst_cents: number;  // GST collected on taxable supplies (1/11th of inclusive sales)
  input_gst_cents: number;   // GST credits on business inputs
  net_gst_cents: number;     // output − input (positive = payable to ATO; negative = refund)
}

/** Net BAS position from total taxable-supply sales (GST-inclusive) and total input GST credits. */
export function computeBasNet(taxableSalesInclusiveCents: number, inputGstCents: number): BasNet {
  const output = gstFromInclusiveCents(taxableSalesInclusiveCents);
  const input = Math.max(0, inputGstCents);
  return { output_gst_cents: output, input_gst_cents: input, net_gst_cents: output - input };
}
