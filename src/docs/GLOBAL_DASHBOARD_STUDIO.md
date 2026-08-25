# AptBooks Global Analytics & Dashboard Studio

## Purpose
Dashboard Studio is an application-wide analytics composition layer. It never grants new access to source data and never stores user-authored SQL. Each widget references a registered semantic metric owned by an AptBooks domain.

## Security and accounting standards
- Every metric execution re-checks the source module permission.
- Dashboard/template data is tenant-owned and protected by PostgreSQL RLS.
- Dashboard metric cache keys include organization and user identity.
- Financial metrics remain currency-aware; mixed-currency nominal totals are not produced.
- Dashboard definitions are declarative: metric key, approved visualization, approved grouping, filters, title and grid position.
- System templates are immutable. User and organization templates are versioned independently of live dashboards.

## Reusable templates
Users with dashboard-management permission can:
1. create a blank template and design it directly;
2. save the current live dashboard canvas as a template;
3. mark a template private or organization-reusable;
4. instantiate a template repeatedly into independent live dashboards;
5. archive their own templates.

Template instantiation copies only design/default filters/widget definitions. It does not copy dashboard shares, placements, revisions, snapshots or live metric results.

## AptBooks starter templates
The source ships with three immutable starter templates:
- Executive 360
- Finance & Liquidity Control
- Operations & Compliance Control

These are code-owned product definitions, not tenant rows, and therefore remain consistent across organizations. A user customizes one by instantiating it into a dashboard and may then save the customized dashboard as a tenant template.

## Migration
Apply `166_global_dashboard_studio.sql` in staging before enabling the Studio. Run migration checksum verification and RLS acceptance tests as part of deployment.
