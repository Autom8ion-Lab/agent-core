// Per-app a8l-os MCP tool allowlists — exact tool names only (no "_*" prefixes). Used both by
// OsMcpClient's client-side `allow` predicate and by each app's CLI wiring for
// `--allowedTools mcp__a8l-os__<name>` (prefix wildcards are unreliable there, per the plan's
// gotcha #3 — so this is the single source of truth for both).
//
// IMPORTANT (verified live against the real project, 2026-07-27): this allowlist is the PRIMARY
// department-scoping boundary for reads, not defense-in-depth on top of RLS. Audited SELECT
// policies across every table these tools touch — only payments/invoices/forms/form_submissions/
// reviews/review_requests/workflows check a real permission (`user_has_..._permission(...)`); every
// other table (projects, contacts, opportunities, conversations, calendars, social_*, drive_*,
// ai_agents, integrations, messages, snippets, reports, proposals, contracts, clara_memories, ...)
// only checks org membership — ANY authenticated org user can read ALL rows regardless of role.
// Confirmed directly: a freshly-minted TuesdayAgent JWT successfully listed `projects_list` data
// straight against the MCP server, even though TuesdayAgent was never granted projects.* — RLS let
// it through. This allowlist is what actually stops that call from ever leaving TUESDAY's app in
// normal operation; if it were ever bypassed (leaked JWT, buggy tool-name change), most tables have
// no second line of defense. Don't weaken this list on the assumption RLS has your back — for most
// tables it doesn't yet. Hardening a8l-os's own RLS to check role_permissions per table is real,
// separate, CRM-side work, out of scope for this integration.
//
// Shared here (not duplicated per-app) so FRIDAY/TUESDAY/CLARA can't silently drift out of sync
// with each other or with the real tool names registered in mcp-server/src/tools/*.ts.
//
// Deliberately excluded everywhere: auth.ts (account/session management — auth_create_user is on
// the "I don't create accounts" list), administration.ts (org/role/user administration), and any
// credential/OAuth-connect tool (drive_oauth_*, gmail_oauth_start, google_oauth_unified,
// google_token_refresh, google_calendar_oauth, secrets_api, secrets_scanner, portal_auth,
// late_connect) — connecting new integrations is a human, interactive action. Destructive/
// approval-gated actions (hard deletes, workflow_approval_queue_update, automations.approve,
// payment issuance/void) are excluded per-app below even where the module is otherwise in scope.

/** FRIDAY — Engineering: projects, project tasks, opportunities (incl. conversion to project),
 *  contacts (no merge/bulk/delete), files, workflows/automation, AI agent config, integrations
 *  (no connect/credential tools), forms, reporting (read-only). */
export const FRIDAY_OS_TOOLS: readonly string[] = [
  // projects
  "projects_list", "projects_get", "projects_create", "projects_update",
  "project_tasks_list", "project_tasks_create", "project_tasks_update", "project_tasks_delete",
  "project_change_requests_list", "project_change_requests_create", "project_change_requests_update",
  "support_tickets_list", "support_tickets_create", "support_tickets_update", "support_ticket_notify", "change_request_notify",
  "project_pipelines_list", "project_stages_list", "project_move_stage", "convert_opportunity_to_project",
  "project_costs_list", "project_costs_create", "project_costs_update",
  "project_notes_create", "project_notes_update",
  "project_activity_list",
  // opportunities
  "opportunities_list", "opportunities_get", "opportunities_create", "opportunities_update",
  "opportunities_bulk_update_stage", "opportunity_notes_list", "opportunity_notes_create",
  "opportunity_close", "opportunity_reopen", "opportunity_stage_history_list",
  "opportunity_timeline_list", "opportunity_timeline_create", "opportunity_set_custom_fields", "opportunity_stats",
  // contacts
  "contacts_list", "contacts_get", "contacts_create", "contacts_update",
  "contact_notes_list", "contact_notes_create", "contact_notes_update",
  "contact_tasks_list", "contact_tasks_create", "contact_tasks_update", "contact_tasks_delete",
  "tags_list", "tags_create", "contact_tags_add", "contact_tags_remove",
  "custom_fields_list", "custom_field_values_set",
  "contact_timeline_list", "contact_timeline_add",
  // files
  "drive_files_list", "drive_files_get", "drive_files_create", "drive_files_update", "drive_files_delete",
  "drive_folders_list", "drive_folders_create", "drive_folders_update", "drive_folders_delete",
  "file_attachments_list", "file_attachments_create", "file_attachments_delete",
  // workflows / automation
  "workflows_list", "workflows_get", "workflows_create", "workflows_update", "workflows_delete",
  "workflow_enrollments_list", "workflow_enrollments_create", "workflow_enrollments_update",
  "workflow_approval_queue_list",
  "workflow_processor", "evaluate_condition", "workflow_ai_action_executor", "workflow_scheduled_processor",
  "workflow_ai_generate", "workflow_publish", "workflow_duplicate", "workflow_versions_list",
  "workflow_scheduled_triggers_list", "workflow_scheduled_triggers_create", "workflow_scheduled_triggers_update", "workflow_scheduled_triggers_delete",
  "workflow_analytics_get",
  // ai_agents (FRIDAY's own domain — excludes ElevenLabs voice config, that's CLARA/voice-ai's)
  "ai_agents_list", "ai_agents_get", "ai_agents_create", "ai_agents_update", "ai_agents_delete",
  "knowledge_collections_list", "knowledge_collections_create", "knowledge_collections_update", "knowledge_collections_delete",
  "ai_agent_execute", "ai_knowledge_embed", "ai_settings_providers", "fetch_provider_models",
  // integrations (no connect/credential tools)
  "integrations_list", "integrations_get",
  "integration_connections_list", "integration_connections_create", "integration_connections_update", "integration_connections_delete",
  "outgoing_webhooks_list", "outgoing_webhooks_create", "outgoing_webhooks_update", "outgoing_webhooks_delete",
  "webhook_deliveries_list", "integrations_webhooks",
  // forms
  "forms_list", "forms_get", "forms_create", "forms_update", "forms_delete",
  "form_submissions_list", "form_submissions_get",
  // reporting (read-only)
  "reports_list", "analytics_dashboard", "report_export",
  // agent tasks (OS-scheduled work): poll/report + owner-facing delivery + orchestration reads
  "agent_whoami", "agent_tasks_poll", "agent_run_report", "agent_run_deliver_confirm", "agent_run_extend_lease",
  "agent_task_runs_list", "agent_task_schedules_list", "deliverable_publish",
  "team_message_send", "team_channels_list",
  // approvals bridge (Wave 3): mirror pending approvals to the hub, pull owner decisions back
  "agent_approval_mirror", "agent_approval_pull_decisions", "agent_approval_ack", "agent_approval_close",
] as const;

/** TUESDAY — Marketing: social media, reputation, conversations, communications (no infra
 *  connect), reporting (full), workflows/automation, forms/surveys, contacts + opportunities
 *  read-only. */
export const TUESDAY_OS_TOOLS: readonly string[] = [
  // social media
  "social_accounts_list",
  "social_posts_list", "social_posts_create", "social_posts_update", "social_posts_delete",
  "social_campaigns_list", "social_campaigns_create", "social_campaigns_update", "social_campaigns_delete",
  "brand_kits_list", "brand_kits_create",
  "social_worker_publish", "late_metrics_fetch",
  "ai_social_campaign_generate", "ai_social_content_generate", "ai_social_chat", "ai_caption_generate",
  "media_kie_process", "media_job_status",
  "social_dm_reply", "social_inbox_messages_sync", "social_comments_sync", "social_comment_reply", "social_comment_hide", "social_comments_list",
  "social_account_groups_list", "social_account_groups_create", "social_account_groups_update",
  "social_guidelines_get", "social_guidelines_upsert",
  // reputation
  "reviews_list", "reviews_get", "reviews_update",
  "review_requests_list", "review_requests_create", "review_requests_update",
  "review_ai_analyze", "review_ai_reply", "review_reply_post", "review_submit",
  "reputation_review_sync", "reputation_review_reply", "reputation_ai_generate",
  "review_providers_list", "reputation_settings_get", "reputation_routing_rules_list",
  // conversations
  "conversations_list", "conversations_get", "conversations_create", "conversations_update",
  "messages_list", "messages_create",
  "snippets_list", "snippets_create", "snippets_update",
  "ai_draft_generate",
  // communications (no mailbox/phone infra connect or config)
  "call_logs_list", "email_domains_list", "email_from_addresses_list",
  "email_send", "email_campaign_domains", "send_sms",
  // reporting (full — TUESDAY's own marketing reporting)
  "reports_list", "reports_create", "reports_update",
  "ai_reports_list", "ai_reports_create", "ai_report_generate", "ai_report_query",
  "analytics_dashboard", "analytics_content_ai", "report_export", "report_email_send",
  // workflows / automation
  "workflows_list", "workflows_get", "workflows_create", "workflows_update", "workflows_delete",
  "workflow_enrollments_list", "workflow_enrollments_create", "workflow_enrollments_update",
  "workflow_approval_queue_list",
  "workflow_processor", "evaluate_condition", "workflow_ai_action_executor", "workflow_scheduled_processor",
  "workflow_ai_generate", "workflow_publish", "workflow_duplicate", "workflow_versions_list",
  "workflow_scheduled_triggers_list", "workflow_scheduled_triggers_create", "workflow_scheduled_triggers_update", "workflow_scheduled_triggers_delete",
  "workflow_analytics_get",
  // forms / surveys
  "forms_list", "forms_get", "forms_create", "forms_update", "forms_delete",
  "form_submissions_list", "form_submissions_get",
  "surveys_list", "surveys_create", "surveys_update", "surveys_delete",
  // contacts / opportunities — read-only
  "contacts_list", "contacts_get",
  "opportunities_list", "opportunities_get",
  // agent tasks (OS-scheduled work): poll/report + owner-facing delivery
  "agent_whoami", "agent_tasks_poll", "agent_run_report", "agent_run_deliver_confirm", "agent_run_extend_lease",
  "agent_task_runs_list", "deliverable_publish", "team_message_send", "team_channels_list",
  // approvals bridge (Wave 3): mirror pending approvals to the hub, pull owner decisions back
  "agent_approval_mirror", "agent_approval_pull_decisions", "agent_approval_ack", "agent_approval_close",
] as const;

/** CLARA — authenticates AS Sean, so scope is broad by identity rather than department. Full
 *  access to calendars, contacts, communications (incl. phone_* — she owns the +1-555-000-0000
 *  cutover), conversations, proposals/contracts, reporting, files, and the full personal-assistant
 *  / Clara-memory / Voice-AI tool family. Read-only on projects and payments. Administration and
 *  auth tools stay excluded even under Sean's identity — that boundary is app-level, not RLS. */
export const CLARA_OS_TOOLS: readonly string[] = [
  // calendars (full — Sean's own calendar)
  "calendars_list", "calendars_get", "calendars_create", "calendars_update", "calendars_delete",
  "appointments_list", "appointments_get", "appointments_create", "appointments_update", "appointments_delete",
  "availability_rules_list", "availability_rules_create", "availability_rules_update", "availability_rules_delete",
  "booking_api", "google_calendar_sync",
  "appointment_types_list", "appointment_types_get", "appointment_types_create", "appointment_types_update", "appointment_types_delete",
  "blocked_slots_list", "blocked_slots_create", "blocked_slots_update", "blocked_slots_delete",
  "google_calendar_connections_list",
  // contacts (full)
  "contacts_list", "contacts_get", "contacts_create", "contacts_update", "contacts_delete",
  "contacts_bulk_assign_owner",
  "contact_notes_list", "contact_notes_create", "contact_notes_update", "contact_notes_delete",
  "contact_tasks_list", "contact_tasks_create", "contact_tasks_update", "contact_tasks_delete",
  "tags_list", "tags_create", "contact_tags_add", "contact_tags_remove",
  "custom_fields_list", "custom_field_values_set", "contacts_merge",
  "contact_timeline_list", "contact_timeline_add",
  // communications (incl. phone_* — Clara owns the live number after the B4 cutover)
  "call_logs_list", "email_domains_list", "email_from_addresses_list",
  "email_send", "email_campaign_domains", "send_sms",
  "phone_settings", "phone_voice_routing", "phone_dnc", "phone_test",
  // conversations (full)
  "conversations_list", "conversations_get", "conversations_create", "conversations_update", "conversations_delete",
  "messages_list", "messages_create",
  "snippets_list", "snippets_create", "snippets_update", "snippets_delete",
  "conversation_rule_execute", "ai_draft_generate",
  // proposals / contracts (full — Sean's own deals)
  "proposals_list", "proposals_get", "proposals_create", "proposals_update", "proposals_delete",
  "contracts_list", "contracts_get", "contracts_create", "contracts_update", "contracts_delete",
  "proposal_ai_generate", "contract_ai_generate", "proposal_signed_pdf",
  "proposal_line_items_list", "proposal_line_items_create", "proposal_line_items_update", "proposal_line_items_delete",
  "proposal_sections_list", "proposal_sections_create", "proposal_sections_update", "proposal_sections_delete",
  "proposal_duplicate", "proposal_archive", "proposal_unarchive",
  "proposal_link_meeting", "proposal_unlink_meeting",
  "proposal_templates_list", "proposal_templates_get", "proposal_templates_create", "proposal_templates_update", "proposal_templates_delete",
  "proposal_signature_status_get", "proposal_comments_list", "proposal_comments_create",
  "contract_sections_list", "contract_sections_create", "contract_sections_update", "contract_sections_delete",
  "contract_link_meeting", "contract_unlink_meeting", "contract_archive", "contract_unarchive",
  "contract_signature_status_get", "contract_comments_list", "contract_comments_create",
  "proposal_send_for_signature", "proposal_signature_resend", "proposal_signature_void",
  "contract_send_for_signature", "contract_signature_resend", "contract_signature_void",
  // reporting (full)
  "reports_list", "reports_create", "reports_update", "reports_delete",
  "ai_reports_list", "ai_reports_get", "ai_reports_create", "ai_reports_delete",
  "ai_report_generate", "ai_report_query", "ai_report_cleanup", "ai_report_schedule_run",
  "analytics_dashboard", "analytics_content_ai", "report_export", "report_email_send",
  // files (full)
  "drive_files_list", "drive_files_get", "drive_files_create", "drive_files_update", "drive_files_delete",
  "drive_folders_list", "drive_folders_create", "drive_folders_update", "drive_folders_delete",
  "file_attachments_list", "file_attachments_create", "file_attachments_delete",
  // projects — read-only
  "projects_list", "projects_get", "project_tasks_list", "project_activity_list",
  // payments — read-only
  "invoices_list", "invoices_get", "payments_list", "products_list",
  "invoice_line_items_list", "recurring_profiles_list", "invoice_templates_list", "payment_reminders_list",
  // personal assistant / Clara memory / meetings / notifications / prefs
  "assistant_threads_list", "assistant_threads_get", "assistant_threads_create", "assistant_threads_delete",
  "clara_memories_list", "meeting_transcriptions_list",
  "assistant_chat", "assistant_voice", "assistant_tts", "assistant_stt_wake", "assistant_stt_final",
  "clara_memory_decay", "assistant_meeting_processor",
  "google_calendar_sync_runner", "meet_reprocess", "meet_follow_up_generate", "dashboard_insights",
  "notifications_list", "notifications_mark_read", "notifications_mark_all_read", "notifications_delete",
  "user_preferences_get", "user_preferences_update", "user_notification_preferences_get", "user_connected_accounts_list",
  "custom_values_list", "custom_values_create", "custom_values_update", "custom_values_delete", "custom_value_categories_list",
  // Voice AI (Clara's own voice runtime)
  "vapi_assistants_list", "vapi_assistants_get", "vapi_assistants_create", "vapi_assistants_update", "vapi_assistants_delete",
  "vapi_calls_list", "vapi_calls_get", "vapi_widgets_list", "vapi_tool_registry_list", "vapi_client", "vapi_webhook", "vapi_tool_gateway",
  // agent tasks (OS-scheduled work): poll/report + owner-facing delivery
  "agent_whoami", "agent_tasks_poll", "agent_run_report", "agent_run_deliver_confirm", "agent_run_extend_lease",
  "agent_task_runs_list", "team_message_send", "team_channels_list",
  // approvals bridge (Wave 3): mirror pending approvals to the hub, pull owner decisions back
  "agent_approval_mirror", "agent_approval_pull_decisions", "agent_approval_ack", "agent_approval_close",
] as const;

/** Exact-match allow predicate for OsMcpConfig.allow — no prefix matching, mirrors --allowedTools. */
export function allowExact(tools: readonly string[]): (toolName: string) => boolean {
  const set = new Set(tools);
  return (toolName) => set.has(toolName);
}

/** Full `mcp__a8l-os__<tool>` names for a Claude Code CLI `--allowedTools` list. */
export function toCliAllowedTools(tools: readonly string[]): string[] {
  return tools.map((t) => `mcp__a8l-os__${t}`);
}
