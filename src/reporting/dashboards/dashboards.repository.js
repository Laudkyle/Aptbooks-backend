const { pool } = require('../../db/pool');

const DASHBOARD_SELECT = `d.id,d.organization_id,d.name,d.description,d.layout_json,d.is_archived,d.created_by_user_id,d.created_at,d.updated_at,
  d.owner_user_id,d.visibility,d.status,d.version,d.default_filters_json,d.last_saved_by_user_id`;
const WIDGET_SELECT = `id,organization_id,dashboard_id,title,widget_type,config_json,position_json,is_archived,created_at,updated_at,metric_key,visualization,display_order,version`;
const TEMPLATE_SELECT = `id,organization_id,name,description,template_scope,owner_user_id,status,version,definition_json,created_by_user_id,last_saved_by_user_id,created_at,updated_at`;

function accessSql(userParam='$2') {
  return `(d.owner_user_id=${userParam}
    OR d.visibility IN ('organization','system')
    OR EXISTS (SELECT 1 FROM dashboard_shares ds WHERE ds.dashboard_id=d.id AND ds.organization_id=d.organization_id AND ds.principal_type='user' AND ds.user_id=${userParam})
    OR EXISTS (
      SELECT 1 FROM dashboard_shares ds
      JOIN user_roles ur ON ur.role_id=ds.role_id AND ur.user_id=${userParam}
      WHERE ds.dashboard_id=d.id AND ds.organization_id=d.organization_id AND ds.principal_type='role'
    ))`;
}

function editAccessSql(userParam='$2') {
  return `(d.owner_user_id=${userParam}
    OR EXISTS (SELECT 1 FROM dashboard_shares ds WHERE ds.dashboard_id=d.id AND ds.organization_id=d.organization_id AND ds.principal_type='user' AND ds.user_id=${userParam} AND ds.can_edit=TRUE)
    OR EXISTS (
      SELECT 1 FROM dashboard_shares ds
      JOIN user_roles ur ON ur.role_id=ds.role_id AND ur.user_id=${userParam}
      WHERE ds.dashboard_id=d.id AND ds.organization_id=d.organization_id AND ds.principal_type='role' AND ds.can_edit=TRUE
    ))`;
}

async function listDashboards({ organizationId, userId, includeArchived=false, limit=100, offset=0 }) {
  const lim=Math.min(Math.max(Number(limit)||100,1),200); const off=Math.max(Number(offset)||0,0);
  const {rows}=await pool.query(
    `SELECT ${DASHBOARD_SELECT}, (${editAccessSql('$2')}) AS can_edit
       FROM dashboards d
      WHERE d.organization_id=$1 AND ${accessSql('$2')}
        AND ($3::boolean OR (d.is_archived=FALSE AND d.status<>'archived'))
      ORDER BY d.updated_at DESC LIMIT $4 OFFSET $5`,[organizationId,userId,Boolean(includeArchived),lim,off]);
  return rows;
}

async function getDashboard({ organizationId, userId, dashboardId }) {
  const {rows}=await pool.query(
    `SELECT ${DASHBOARD_SELECT}, (${editAccessSql('$2')}) AS can_edit
       FROM dashboards d WHERE d.organization_id=$1 AND d.id=$3 AND ${accessSql('$2')} LIMIT 1`,
    [organizationId,userId,dashboardId]);
  return rows[0]||null;
}

async function listWidgets({ organizationId, dashboardId, includeArchived=false, client=null }) {
  const db=client||pool;
  const {rows}=await db.query(
    `SELECT ${WIDGET_SELECT} FROM dashboard_widgets
      WHERE organization_id=$1 AND dashboard_id=$2 AND ($3::boolean OR is_archived=FALSE)
      ORDER BY display_order,created_at`,[organizationId,dashboardId,Boolean(includeArchived)]);
  return rows;
}

async function definition({ organizationId, userId, dashboardId }) {
  const dashboard=await getDashboard({organizationId,userId,dashboardId});
  if(!dashboard) return null;
  const widgets=await listWidgets({organizationId,dashboardId});
  return {dashboard,widgets};
}

async function createDashboard({ organizationId, userId, name, description, visibility='private', defaultFilters={}, widgets=[] }) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query(
      `INSERT INTO dashboards(organization_id,name,description,layout_json,created_by_user_id,owner_user_id,visibility,status,version,default_filters_json,last_saved_by_user_id)
       VALUES($1,$2,$3,$4,$5,$5,$6,'active',1,$7,$5)
       RETURNING id,organization_id,name,description,layout_json,is_archived,created_by_user_id,created_at,updated_at,owner_user_id,visibility,status,version,default_filters_json,last_saved_by_user_id`,
      [organizationId,name,description||null,JSON.stringify({columns:12}),userId,visibility,JSON.stringify(defaultFilters||{})]);
    const dashboard=rows[0];
    await insertWidgets(client,{organizationId,dashboardId:dashboard.id,widgets});
    const def={dashboard:{...dashboard,can_edit:true},widgets:await listWidgets({organizationId,dashboardId:dashboard.id,client})};
    await insertRevision(client,{organizationId,dashboardId:dashboard.id,version:1,definition:def,userId});
    await client.query('COMMIT');
    return def;
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}

async function insertWidgets(client,{organizationId,dashboardId,widgets}) {
  let order=0;
  for(const widget of widgets||[]) {
    await client.query(
      `INSERT INTO dashboard_widgets(organization_id,dashboard_id,title,widget_type,config_json,position_json,is_archived,metric_key,visualization,display_order,version)
       VALUES($1,$2,$3,$4,$5,$6,FALSE,$7,$8,$9,1)`,
      [organizationId,dashboardId,widget.title,widget.visualization,JSON.stringify(widget.config||{}),JSON.stringify(widget.position||{}),widget.metricKey,widget.visualization,order++]);
  }
}

async function insertRevision(client,{organizationId,dashboardId,version,definition,userId}) {
  await client.query(`INSERT INTO dashboard_revisions(organization_id,dashboard_id,version,definition_json,created_by_user_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dashboard_id,version) DO NOTHING`,[organizationId,dashboardId,version,JSON.stringify(definition),userId]);
}

async function saveDesign({ organizationId, userId, dashboardId, expectedVersion, name, description, visibility, defaultFilters, widgets }) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows:locked}=await client.query(
      `SELECT ${DASHBOARD_SELECT}, (${editAccessSql('$2')}) AS can_edit
         FROM dashboards d WHERE d.organization_id=$1 AND d.id=$3 AND ${accessSql('$2')} FOR UPDATE`,[organizationId,userId,dashboardId]);
    const before=locked[0];
    if(!before){await client.query('ROLLBACK');return {notFound:true};}
    if(!before.can_edit){await client.query('ROLLBACK');return {forbidden:true};}
    if(Number(before.version)!==Number(expectedVersion)){await client.query('ROLLBACK');return {conflict:true,currentVersion:Number(before.version)};}
    const nextVersion=Number(before.version)+1;
    const {rows}=await client.query(
      `UPDATE dashboards SET name=$4,description=$5,visibility=$6,default_filters_json=$7,version=$8,last_saved_by_user_id=$2,updated_at=NOW(),is_archived=FALSE,status='active'
        WHERE organization_id=$1 AND id=$3 RETURNING id,organization_id,name,description,layout_json,is_archived,created_by_user_id,created_at,updated_at,owner_user_id,visibility,status,version,default_filters_json,last_saved_by_user_id`,
      [organizationId,userId,dashboardId,name,description||null,visibility,JSON.stringify(defaultFilters||{}),nextVersion]);
    await client.query(`DELETE FROM dashboard_widgets WHERE organization_id=$1 AND dashboard_id=$2`,[organizationId,dashboardId]);
    await insertWidgets(client,{organizationId,dashboardId,widgets});
    const current={dashboard:{...rows[0],can_edit:true},widgets:await listWidgets({organizationId,dashboardId,client})};
    await insertRevision(client,{organizationId,dashboardId,version:nextVersion,definition:current,userId});
    await client.query('COMMIT');
    return {definition:current,before};
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}


async function getWidgetDashboardId({organizationId,widgetId}) {
  const {rows}=await pool.query(
    `SELECT dashboard_id FROM dashboard_widgets WHERE organization_id=$1 AND id=$2 LIMIT 1`,
    [organizationId,widgetId]
  );
  return rows[0]?.dashboard_id || null;
}

async function archiveDashboard({ organizationId,userId,dashboardId }) {
  const {rows}=await pool.query(
    `UPDATE dashboards d SET is_archived=TRUE,status='archived',updated_at=NOW(),last_saved_by_user_id=$2
      WHERE d.organization_id=$1 AND d.id=$3 AND ${editAccessSql('$2')}
      RETURNING id,organization_id,name,description,layout_json,is_archived,created_by_user_id,created_at,updated_at,owner_user_id,visibility,status,version,default_filters_json,last_saved_by_user_id`,[organizationId,userId,dashboardId]);
  return rows[0]||null;
}

async function listRevisions({organizationId,dashboardId}) {
  const {rows}=await pool.query(`SELECT id,dashboard_id,version,created_by_user_id,created_at FROM dashboard_revisions WHERE organization_id=$1 AND dashboard_id=$2 ORDER BY version DESC LIMIT 50`,[organizationId,dashboardId]); return rows;
}

async function replaceShares({organizationId,dashboardId,userId,shares}) {
  const client=await pool.connect(); try{await client.query('BEGIN');await client.query(`DELETE FROM dashboard_shares WHERE organization_id=$1 AND dashboard_id=$2`,[organizationId,dashboardId]);
    for(const s of shares||[]) await client.query(`INSERT INTO dashboard_shares(organization_id,dashboard_id,principal_type,user_id,role_id,can_edit,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[organizationId,dashboardId,s.principalType,s.userId||null,s.roleId||null,Boolean(s.canEdit),userId]);
    await client.query('COMMIT'); return listShares({organizationId,dashboardId});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function listShares({organizationId,dashboardId}) {const {rows}=await pool.query(`SELECT id,principal_type,user_id,role_id,can_edit,created_at FROM dashboard_shares WHERE organization_id=$1 AND dashboard_id=$2 ORDER BY created_at`,[organizationId,dashboardId]);return rows;}

async function replacePlacements({organizationId,dashboardId,userId,placements}) {
  const client=await pool.connect(); try{await client.query('BEGIN');
    // Replace only scopes represented by this request. Personal placement always belongs to actor.
    await client.query(`DELETE FROM dashboard_placements WHERE organization_id=$1 AND dashboard_id=$2 AND (placement_scope='organization' OR (placement_scope='user' AND user_id=$3))`,[organizationId,dashboardId,userId]);
    for(const p of placements||[]) {
      const scope=p.scope==='organization'?'organization':'user';
      await client.query(`INSERT INTO dashboard_placements(organization_id,dashboard_id,location_key,placement_scope,user_id,role_id,sort_order,is_default,created_by_user_id) VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8)`,[organizationId,dashboardId,p.locationKey,scope,scope==='user'?userId:null,Number(p.sortOrder)||0,Boolean(p.isDefault),userId]);
    }
    await client.query('COMMIT'); return listDashboardPlacements({organizationId,dashboardId,userId});
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function listDashboardPlacements({organizationId,dashboardId,userId}) {const {rows}=await pool.query(`SELECT id,location_key,placement_scope,user_id,role_id,sort_order,is_default,created_at,updated_at FROM dashboard_placements WHERE organization_id=$1 AND dashboard_id=$2 AND (placement_scope='organization' OR (placement_scope='user' AND user_id=$3)) ORDER BY location_key,sort_order`,[organizationId,dashboardId,userId]);return rows;}

async function dashboardsForLocation({organizationId,userId,locationKey}) {
  const {rows}=await pool.query(
    `SELECT ${DASHBOARD_SELECT},p.location_key,p.placement_scope,p.sort_order,p.is_default,(${editAccessSql('$2')}) AS can_edit
       FROM dashboard_placements p JOIN dashboards d ON d.id=p.dashboard_id AND d.organization_id=p.organization_id
      WHERE p.organization_id=$1 AND p.location_key=$3 AND d.status='active' AND d.is_archived=FALSE AND ${accessSql('$2')}
        AND (p.placement_scope='organization' OR (p.placement_scope='user' AND p.user_id=$2) OR (p.placement_scope='role' AND EXISTS(SELECT 1 FROM user_roles ur WHERE ur.user_id=$2 AND ur.role_id=p.role_id)))
      ORDER BY p.is_default DESC,CASE p.placement_scope WHEN 'user' THEN 0 WHEN 'role' THEN 1 ELSE 2 END,p.sort_order,d.name`,[organizationId,userId,locationKey]);
  return rows;
}

async function createSnapshot({organizationId,dashboardId,userId,definition,data,name}) {const {rows}=await pool.query(`INSERT INTO dashboard_snapshots(organization_id,dashboard_id,dashboard_version,name,definition_json,data_json,generated_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,dashboard_id,dashboard_version,name,generated_by_user_id,generated_at`,[organizationId,dashboardId,definition.dashboard.version,name||null,JSON.stringify(definition),JSON.stringify(data),userId]);return rows[0];}
async function listSnapshots({organizationId,dashboardId}) {const {rows}=await pool.query(`SELECT id,dashboard_id,dashboard_version,name,generated_by_user_id,generated_at FROM dashboard_snapshots WHERE organization_id=$1 AND dashboard_id=$2 ORDER BY generated_at DESC LIMIT 50`,[organizationId,dashboardId]);return rows;}

function templateAccessSql(userParam='$2'){return `(t.owner_user_id=${userParam} OR t.template_scope='organization')`;}
async function listTemplates({organizationId,userId,includeArchived=false}){const {rows}=await pool.query(`SELECT ${TEMPLATE_SELECT},(t.owner_user_id=$2) AS can_edit FROM dashboard_templates t WHERE t.organization_id=$1 AND ${templateAccessSql('$2')} AND ($3::boolean OR t.status='active') ORDER BY t.updated_at DESC`,[organizationId,userId,Boolean(includeArchived)]);return rows;}
async function getTemplate({organizationId,userId,templateId}){const {rows}=await pool.query(`SELECT ${TEMPLATE_SELECT},(t.owner_user_id=$2) AS can_edit FROM dashboard_templates t WHERE t.organization_id=$1 AND t.id=$3 AND ${templateAccessSql('$2')} LIMIT 1`,[organizationId,userId,templateId]);return rows[0]||null;}
async function createTemplate({organizationId,userId,name,description,scope,definition}){const client=await pool.connect();try{await client.query('BEGIN');const {rows}=await client.query(`INSERT INTO dashboard_templates(organization_id,name,description,template_scope,owner_user_id,status,version,definition_json,created_by_user_id,last_saved_by_user_id) VALUES($1,$2,$3,$4,$5,'active',1,$6,$5,$5) RETURNING ${TEMPLATE_SELECT.replaceAll('t.','')}`,[organizationId,name,description||null,scope,userId,JSON.stringify(definition)]);const t=rows[0];await client.query(`INSERT INTO dashboard_template_revisions(organization_id,template_id,version,definition_json,created_by_user_id) VALUES($1,$2,1,$3,$4)`,[organizationId,t.id,JSON.stringify(definition),userId]);await client.query('COMMIT');return t;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function saveTemplate({organizationId,userId,templateId,expectedVersion,name,description,scope,definition}){const client=await pool.connect();try{await client.query('BEGIN');const {rows:beforeRows}=await client.query(`SELECT ${TEMPLATE_SELECT} FROM dashboard_templates t WHERE t.organization_id=$1 AND t.id=$2 FOR UPDATE`,[organizationId,templateId]);const before=beforeRows[0];if(!before){await client.query('ROLLBACK');return {notFound:true};}if(before.owner_user_id!==userId){await client.query('ROLLBACK');return {forbidden:true};}if(Number(before.version)!==Number(expectedVersion)){await client.query('ROLLBACK');return {conflict:true,currentVersion:Number(before.version)};}const next=Number(before.version)+1;const {rows}=await client.query(`UPDATE dashboard_templates SET name=$3,description=$4,template_scope=$5,definition_json=$6,version=$7,last_saved_by_user_id=$2,updated_at=NOW() WHERE organization_id=$1 AND id=$8 RETURNING ${TEMPLATE_SELECT.replaceAll('t.','')}`,[organizationId,userId,name,description||null,scope,JSON.stringify(definition),next,templateId]);await client.query(`INSERT INTO dashboard_template_revisions(organization_id,template_id,version,definition_json,created_by_user_id) VALUES($1,$2,$3,$4,$5)`,[organizationId,templateId,next,JSON.stringify(definition),userId]);await client.query('COMMIT');return {template:rows[0],before};}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
async function archiveTemplate({organizationId,userId,templateId}){const {rows}=await pool.query(`UPDATE dashboard_templates SET status='archived',updated_at=NOW(),last_saved_by_user_id=$2 WHERE organization_id=$1 AND id=$3 AND owner_user_id=$2 RETURNING ${TEMPLATE_SELECT.replaceAll('t.','')}`,[organizationId,userId,templateId]);return rows[0]||null;}

module.exports={
  listDashboards,getDashboard,listWidgets,definition,createDashboard,saveDesign,getWidgetDashboardId,archiveDashboard,listRevisions,
  replaceShares,listShares,replacePlacements,listDashboardPlacements,dashboardsForLocation,createSnapshot,listSnapshots,
  listTemplates,getTemplate,createTemplate,saveTemplate,archiveTemplate,
};
