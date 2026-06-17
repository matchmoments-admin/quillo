-- 0060: refund→expense link for matched refund-netting (#258).
-- WHY: refund_netting v1 nets ALL refund credits against the whole deduction pool, so personal
--      reimbursements (flatmate cost-sharing, personal returns the AI bucketed as 'refund') wrongly
--      REDUCE unrelated work/property deductions — under-stating the position (the under-claim mirror
--      of #254). v2 nets a refund ONLY against the specific DEDUCTIBLE expense it reverses; an
--      unlinked refund, or one pointing to a non-deductible/personal expense, is position-neutral.
--      This column records that link (set via TxnDetail "this refunds which expense?").
-- Apply: npx wrangler d1 execute tax-agent-db --remote --file=migrations/0060_refund_for_txn.sql
-- Idempotency: ADD COLUMN is apply-once; index IF NOT EXISTS. NO backfill — existing refunds stay
--   unlinked ⇒ position-neutral under v2 (the safe, conservative default; v1 behaviour is unchanged
--   until the refund_netting_v2 flag is flipped).
ALTER TABLE transactions ADD COLUMN refund_for_txn_id TEXT; -- on a refund credit: the deductible expense (transactions.id) it reverses
CREATE INDEX IF NOT EXISTS idx_txn_refund_for ON transactions(user_id, refund_for_txn_id);
