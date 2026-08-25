const { pool } = require('../../../db/pool');
function db(client){return client||pool;}
async function findActive(orgId,bankAccountId,periodId,client=null){const {rows}=await db(client).query(`SELECT * FROM bank_reconciliations WHERE organization_id=$1 AND bank_account_id=$2 AND period_id=$3 AND status='reconciled' ORDER BY reconciled_at DESC LIMIT 1`,[orgId,bankAccountId,periodId]);return rows[0]||null;}
async function create(orgId,userId,{bankAccountId,periodId,statementId},client=null){const {rows}=await db(client).query(`INSERT INTO bank_reconciliations(organization_id,bank_account_id,period_id,statement_id,reconciled_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[orgId,bankAccountId,periodId,statementId||null,userId||null]);return rows[0];}
async function list(orgId,query={},client=null){const limit=Math.min(Number(query.limit||50),200),offset=Math.max(Number(query.offset||0),0);const params=[orgId];let where='WHERE br.organization_id=$1';if(query.bankAccountId){params.push(query.bankAccountId);where+=` AND br.bank_account_id=$${params.length}`;}if(query.periodId){params.push(query.periodId);where+=` AND br.period_id=$${params.length}`;}params.push(limit,offset);const {rows}=await db(client).query(`SELECT br.*,ba.code AS bank_account_code,ba.name AS bank_account_name,ba.currency_code,ap.code AS period_code,s.statement_date,
 COALESCE(ru.full_name,ru.email) AS reconciled_by_name,COALESCE(cu.full_name,cu.email) AS closed_by_name
 FROM bank_reconciliations br JOIN bank_accounts ba ON ba.id=br.bank_account_id AND ba.organization_id=br.organization_id
 JOIN accounting_periods ap ON ap.id=br.period_id AND ap.organization_id=br.organization_id LEFT JOIN bank_statements s ON s.id=br.statement_id AND s.organization_id=br.organization_id
 LEFT JOIN users ru ON ru.id=br.reconciled_by AND ru.organization_id=br.organization_id LEFT JOIN users cu ON cu.id=br.closed_by AND cu.organization_id=br.organization_id
 ${where} ORDER BY br.reconciled_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);return rows;}
async function getById(orgId,id,client=null,forUpdate=false){if (forUpdate){const {rows}=await db(client).query(`SELECT * FROM bank_reconciliations WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[orgId,id]);return rows[0]||null;}const {rows}=await db(client).query(`SELECT br.*,ba.code AS bank_account_code,ba.name AS bank_account_name,ba.currency_code,ap.code AS period_code,s.statement_date,s.status AS statement_status,
 COALESCE(ru.full_name,ru.email) AS reconciled_by_name,COALESCE(cu.full_name,cu.email) AS closed_by_name
 FROM bank_reconciliations br JOIN bank_accounts ba ON ba.id=br.bank_account_id AND ba.organization_id=br.organization_id
 JOIN accounting_periods ap ON ap.id=br.period_id AND ap.organization_id=br.organization_id LEFT JOIN bank_statements s ON s.id=br.statement_id AND s.organization_id=br.organization_id
 LEFT JOIN users ru ON ru.id=br.reconciled_by AND ru.organization_id=br.organization_id LEFT JOIN users cu ON cu.id=br.closed_by AND cu.organization_id=br.organization_id
 WHERE br.organization_id=$1 AND br.id=$2`,[orgId,id]);return rows[0]||null;}
async function resolveStatement(orgId,bankAccountId,periodId,statementId,client=null){
 const conn=db(client);if(statementId){const {rows}=await conn.query(`SELECT s.* FROM bank_statements s JOIN accounting_periods p ON p.organization_id=s.organization_id AND p.id=$3 WHERE s.organization_id=$1 AND s.bank_account_id=$2 AND s.id=$4 AND s.statement_date<=p.end_date`,[orgId,bankAccountId,periodId,statementId]);return rows[0]||null;}
 const {rows}=await conn.query(`SELECT s.* FROM bank_statements s JOIN accounting_periods p ON p.organization_id=s.organization_id AND p.id=$3 WHERE s.organization_id=$1 AND s.bank_account_id=$2 AND s.statement_date<=p.end_date ORDER BY s.statement_date DESC LIMIT 1`,[orgId,bankAccountId,periodId]);return rows[0]||null;
}
async function computeControl(orgId,reconciliation,client=null){
 const conn=db(client);const {rows}=await conn.query(`WITH ctx AS (
   SELECT br.id,br.bank_account_id,br.period_id,br.statement_id,ba.gl_account_id,ba.currency_code,ba.reconciliation_tolerance,p.end_date
   FROM bank_reconciliations br JOIN bank_accounts ba ON ba.id=br.bank_account_id AND ba.organization_id=br.organization_id
   JOIN accounting_periods p ON p.id=br.period_id AND p.organization_id=br.organization_id WHERE br.organization_id=$1 AND br.id=$2
 ), stmt AS (SELECT s.id,s.closing_balance,s.status FROM bank_statements s JOIN ctx c ON c.statement_id=s.id WHERE s.organization_id=$1),
 gl AS (SELECT COALESCE(SUM(CASE WHEN COALESCE(jel.currency_code,c.currency_code)=c.currency_code THEN COALESCE(jel.debit,0)-COALESCE(jel.credit,0) ELSE 0 END),0)::numeric AS ledger_balance,
       COUNT(*) FILTER (WHERE COALESCE(jel.currency_code,c.currency_code)<>c.currency_code)::int AS wrong_currency_lines
       FROM ctx c LEFT JOIN journal_entries je ON je.organization_id=$1 AND je.status='posted' AND je.entry_date<=c.end_date
       LEFT JOIN journal_entry_lines jel ON jel.journal_entry_id=je.id AND jel.account_id=c.gl_account_id),
 unmatched AS (SELECT COUNT(*) FILTER(WHERE NOT l.matched)::int AS unmatched_count FROM stmt s LEFT JOIN bank_statement_lines l ON l.statement_id=s.id)
 SELECT c.currency_code,c.reconciliation_tolerance AS tolerance_amount,s.id AS statement_id,s.status AS statement_status,s.closing_balance AS statement_balance,
        gl.ledger_balance,(s.closing_balance-gl.ledger_balance)::numeric AS difference,u.unmatched_count,gl.wrong_currency_lines
 FROM ctx c LEFT JOIN stmt s ON TRUE CROSS JOIN gl CROSS JOIN unmatched u`,[orgId,reconciliation.id]);return rows[0]||null;
}
async function attachStatement(orgId,id,statementId,client=null){const {rows}=await db(client).query(`UPDATE bank_reconciliations SET statement_id=$3 WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,id,statementId]);return rows[0]||null;}
async function close(orgId,id,userId,note,control,client=null){const {rows}=await db(client).query(`UPDATE bank_reconciliations SET is_locked=TRUE,closed_at=NOW(),closed_by=$3,close_note=$4,
 statement_balance=$5,ledger_balance=$6,difference=$7,unmatched_count=$8,tolerance_amount=$9,control_json=$10 WHERE organization_id=$1 AND id=$2 RETURNING *`,
 [orgId,id,userId||null,note||null,control.statement_balance,control.ledger_balance,control.difference,control.unmatched_count,control.tolerance_amount,JSON.stringify(control)]);return rows[0]||null;}
async function unlock(orgId,id,client=null){const {rows}=await db(client).query(`UPDATE bank_reconciliations SET is_locked=FALSE,closed_at=NULL,closed_by=NULL,close_note=NULL WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,id]);return rows[0]||null;}
async function setStatementStatus(orgId,statementId,status,userId=null,client=null){if(!statementId)return;await db(client).query(`UPDATE bank_statements SET status=$3,locked_at=CASE WHEN $3='locked' THEN NOW() ELSE NULL END,locked_by=CASE WHEN $3='locked' THEN $4 ELSE NULL END,updated_at=NOW() WHERE organization_id=$1 AND id=$2`,[orgId,statementId,status,userId]);}
module.exports={create,findActive,list,getById,resolveStatement,computeControl,attachStatement,close,unlock,setStatementStatus};
