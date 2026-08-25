const { pool } = require('../../../db/pool');
function db(client){return client||pool;}

async function createStatement(orgId,createdBy,payload,client=null){
 const {rows}=await db(client).query(`INSERT INTO bank_statements(
   organization_id,bank_account_id,statement_date,opening_balance,closing_balance,created_by,status,source_type,external_statement_id,import_checksum,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,NOW()) RETURNING *`,
   [orgId,payload.bankAccountId,payload.statementDate,payload.openingBalance||'0',payload.closingBalance||'0',createdBy||null,payload.sourceType||'manual',payload.externalStatementId||null,payload.importChecksum||null]);
 return rows[0];
}
async function getStatement(orgId,statementId,client=null,forUpdate=false){
 const lock=forUpdate?' FOR UPDATE':'';
 const {rows}=await db(client).query(`SELECT s.*,ba.code AS bank_account_code,ba.name AS bank_account_name,ba.currency_code,
   ba.reconciliation_tolerance FROM bank_statements s JOIN bank_accounts ba ON ba.id=s.bank_account_id AND ba.organization_id=s.organization_id
   WHERE s.organization_id=$1 AND s.id=$2${lock}`,[orgId,statementId]); return rows[0]||null;
}
async function listStatementLines(orgId,statementId,{limit=200,offset=0,matched}={},client=null){
 const params=[orgId,statementId]; let matchedClause=''; if(typeof matched==='boolean'){params.push(matched);matchedClause=` AND l.matched=$${params.length}`;} params.push(limit,offset);
 const {rows}=await db(client).query(`SELECT l.*,m.journal_entry_id AS match_journal_entry_id,je.entry_no AS match_journal_entry_no,
   m.matched_amount AS match_amount,m.matched_at AS match_at,m.matched_by AS match_by
   FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.statement_id
   LEFT JOIN bank_matches m ON m.bank_statement_line_id=l.id LEFT JOIN journal_entries je ON je.id=m.journal_entry_id AND je.organization_id=s.organization_id
   WHERE s.organization_id=$1 AND s.id=$2${matchedClause}
   ORDER BY l.txn_date DESC,l.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params); return rows;
}
async function addLines(orgId,bankAccountId,statementId,lines,userId,client=null){
 const conn=db(client),results=[];
 for(const l of lines){
  try{
   const {rows}=await conn.query(`INSERT INTO bank_statement_lines(statement_id,txn_date,description,amount,reference,external_id,line_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[statementId,l.txnDate,l.description||null,l.amount,l.reference||null,l.externalId||null,l.lineHash||null]);
   results.push(rows[0]);
   await conn.query(`INSERT INTO bank_transactions(organization_id,bank_account_id,txn_date,amount,description,reference,source_type,source_id,statement_line_id,created_by,external_id)
     VALUES($1,$2,$3,$4,$5,$6,'statement_line',$7,$7,$8,$9) ON CONFLICT (organization_id,bank_account_id,external_id) DO NOTHING`,
     [orgId,bankAccountId,rows[0].txn_date,rows[0].amount,rows[0].description,rows[0].reference,rows[0].id,userId||null,`stmtline:${rows[0].id}`]);
  }catch(e){
   if(e?.code==='23505'){
    if(l.externalId){const {rows}=await conn.query(`SELECT id,statement_id,txn_date,description,amount,reference,matched,matched_journal_entry_id,created_at,external_id,line_hash,matched_by,matched_at,match_method,match_rule_version,match_reason FROM bank_statement_lines WHERE statement_id=$1 AND external_id=$2 LIMIT 1`,[statementId,l.externalId]);if(rows.length){results.push(rows[0]);continue;}}
    if(l.lineHash){const {rows}=await conn.query(`SELECT id,statement_id,txn_date,description,amount,reference,matched,matched_journal_entry_id,created_at,external_id,line_hash,matched_by,matched_at,match_method,match_rule_version,match_reason FROM bank_statement_lines WHERE statement_id=$1 AND line_hash=$2 LIMIT 1`,[statementId,l.lineHash]);if(rows.length){results.push(rows[0]);continue;}}
   } throw e;
  }
 }
 await conn.query(`UPDATE bank_statements SET line_count=(SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=$1),updated_at=NOW() WHERE organization_id=$2 AND id=$1`,[statementId,orgId]);
 return results;
}
async function matchLine(orgId,lineId,{journalEntryId,matchedBy,matchMethod,matchReason,matchRuleVersion},client=null){
 const conn=db(client); const {rows:lineRows}=await conn.query(`SELECT l.id,l.matched,l.matched_journal_entry_id,s.status
   FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.statement_id WHERE s.organization_id=$1 AND l.id=$2 FOR UPDATE`,[orgId,lineId]);
 if(!lineRows.length)return null; if(lineRows[0].status==='locked'){const e=new Error('Locked statement lines cannot be changed');e.code='BANK_STATEMENT_LOCKED';throw e;}
 if(lineRows[0].matched&&lineRows[0].matched_journal_entry_id&&String(lineRows[0].matched_journal_entry_id)!==String(journalEntryId)){const e=new Error('Statement line already matched to a different journal entry');e.code='BANK_LINE_ALREADY_MATCHED';throw e;}
 await conn.query(`UPDATE bank_statement_lines SET matched=true,matched_journal_entry_id=$2,matched_by=$3,matched_at=NOW(),match_method=$4,match_reason=$5,match_rule_version=$6 WHERE id=$1`,[lineId,journalEntryId,matchedBy||null,matchMethod||null,matchReason||null,matchRuleVersion||null]);
 await conn.query(`INSERT INTO bank_matches(organization_id,bank_statement_line_id,journal_entry_id,matched_amount,matched_by)
   SELECT s.organization_id,l.id,$2,l.amount,$3 FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.statement_id WHERE l.id=$1
   ON CONFLICT(bank_statement_line_id) DO UPDATE SET journal_entry_id=EXCLUDED.journal_entry_id,matched_amount=EXCLUDED.matched_amount,matched_at=NOW(),matched_by=EXCLUDED.matched_by`,[lineId,journalEntryId,matchedBy||null]);
 await conn.query(`UPDATE bank_transactions SET journal_entry_id=$2,source_type='journal',source_id=$2 WHERE statement_line_id=$1`,[lineId,journalEntryId]);
 const {rows}=await conn.query(`SELECT id,statement_id,txn_date,description,amount,reference,matched,matched_journal_entry_id,created_at,external_id,line_hash,matched_by,matched_at,match_method,match_rule_version,match_reason FROM bank_statement_lines WHERE id=$1`,[lineId]);return rows[0];
}
async function unmatchLine(orgId,lineId,client=null){
 const conn=db(client); const {rows}=await conn.query(`SELECT l.*,s.status FROM bank_statement_lines l JOIN bank_statements s ON s.id=l.statement_id WHERE s.organization_id=$1 AND l.id=$2 FOR UPDATE`,[orgId,lineId]);
 if(!rows.length)return null;if(rows[0].status==='locked'){const e=new Error('Locked statement lines cannot be changed');e.code='BANK_STATEMENT_LOCKED';throw e;}
 await conn.query(`DELETE FROM bank_matches WHERE bank_statement_line_id=$1`,[lineId]);
 await conn.query(`UPDATE bank_statement_lines SET matched=false,matched_journal_entry_id=NULL,matched_by=NULL,matched_at=NULL,match_method=NULL,match_rule_version=NULL,match_reason=NULL WHERE id=$1`,[lineId]);
 await conn.query(`UPDATE bank_transactions SET journal_entry_id=NULL,source_type='statement_line',source_id=$1 WHERE statement_line_id=$1`,[lineId]);
 const {rows:out}=await conn.query(`SELECT id,statement_id,txn_date,description,amount,reference,matched,matched_journal_entry_id,created_at,external_id,line_hash,matched_by,matched_at,match_method,match_rule_version,match_reason FROM bank_statement_lines WHERE id=$1`,[lineId]);return out[0];
}
async function getControl(orgId,statementId,client=null){
 const {rows}=await db(client).query(`SELECT s.id,s.bank_account_id,s.opening_balance,s.closing_balance,ba.reconciliation_tolerance,
   COUNT(l.id)::int AS line_count,COALESCE(SUM(l.amount),0)::numeric AS line_total,
   (s.closing_balance-s.opening_balance)::numeric AS expected_movement,
   (COALESCE(SUM(l.amount),0)-(s.closing_balance-s.opening_balance))::numeric AS control_difference,
   COUNT(*) FILTER (WHERE l.id IS NOT NULL AND NOT l.matched)::int AS unmatched_count
   FROM bank_statements s JOIN bank_accounts ba ON ba.id=s.bank_account_id AND ba.organization_id=s.organization_id
   LEFT JOIN bank_statement_lines l ON l.statement_id=s.id WHERE s.organization_id=$1 AND s.id=$2
   GROUP BY s.id,ba.reconciliation_tolerance`,[orgId,statementId]);return rows[0]||null;
}
async function markValidated(orgId,statementId,userId,control,client=null){const {rows}=await db(client).query(`UPDATE bank_statements SET status='validated',line_count=$3,control_difference=$4,validated_at=NOW(),validated_by=$5,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,statementId,control.line_count,control.control_difference,userId||null]);return rows[0]||null;}
async function markLocked(orgId,statementId,userId,client=null){const {rows}=await db(client).query(`UPDATE bank_statements SET status='locked',locked_at=NOW(),locked_by=$3,updated_at=NOW() WHERE organization_id=$1 AND id=$2 RETURNING *`,[orgId,statementId,userId||null]);return rows[0]||null;}
async function listStatements(orgId){const {rows}=await pool.query(`SELECT s.*,ba.code AS bank_account_code,ba.name AS bank_account_name,ba.currency_code FROM bank_statements s JOIN bank_accounts ba ON ba.id=s.bank_account_id AND ba.organization_id=s.organization_id WHERE s.organization_id=$1 ORDER BY s.statement_date DESC LIMIT 500`,[orgId]);return rows;}
module.exports={createStatement,getStatement,listStatementLines,addLines,matchLine,unmatchLine,getControl,markValidated,markLocked,listStatements};
