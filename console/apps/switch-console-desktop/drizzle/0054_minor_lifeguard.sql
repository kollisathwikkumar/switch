CREATE TABLE `tracemind_graph_nodes` (
	`project_id` text NOT NULL,
	`revision` text NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`source_path` text,
	`start_line` integer,
	`end_line` integer,
	`stale` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`project_id`, `revision`, `id`),
	FOREIGN KEY (`project_id`,`revision`) REFERENCES `tracemind_graph_revisions`(`project_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_nodes_revision` ON `tracemind_graph_nodes` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_nodes_source` ON `tracemind_graph_nodes` (`project_id`,`source_path`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_nodes_kind` ON `tracemind_graph_nodes` (`project_id`,`revision`,`kind`);--> statement-breakpoint
CREATE TABLE `tracemind_graph_parser_failures` (
	`project_id` text NOT NULL,
	`revision` text NOT NULL,
	`ordinal` integer NOT NULL,
	`path` text NOT NULL,
	`language` text NOT NULL,
	`message` text NOT NULL,
	PRIMARY KEY(`project_id`, `revision`, `ordinal`),
	FOREIGN KEY (`project_id`,`revision`) REFERENCES `tracemind_graph_revisions`(`project_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_parser_failures_revision` ON `tracemind_graph_parser_failures` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_parser_failures_path` ON `tracemind_graph_parser_failures` (`project_id`,`revision`,`path`);--> statement-breakpoint
CREATE TABLE `tracemind_graph_relationships` (
	`project_id` text NOT NULL,
	`revision` text NOT NULL,
	`id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`relation` text NOT NULL,
	`source_path` text,
	`stale` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`project_id`, `revision`, `id`),
	FOREIGN KEY (`project_id`,`revision`) REFERENCES `tracemind_graph_revisions`(`project_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_revision` ON `tracemind_graph_relationships` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_source` ON `tracemind_graph_relationships` (`project_id`,`revision`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_target` ON `tracemind_graph_relationships` (`project_id`,`revision`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_path` ON `tracemind_graph_relationships` (`project_id`,`source_path`,`revision`);--> statement-breakpoint
CREATE TABLE `tracemind_graph_retrieval_reasons` (
	`project_id` text NOT NULL,
	`revision` text NOT NULL,
	`id` text NOT NULL,
	`evidence_node_id` text NOT NULL,
	`reason` text NOT NULL,
	`retrieved_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `revision`, `id`),
	FOREIGN KEY (`project_id`,`revision`) REFERENCES `tracemind_graph_revisions`(`project_id`,`revision`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_retrieval_reasons_revision` ON `tracemind_graph_retrieval_reasons` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_retrieval_reasons_evidence` ON `tracemind_graph_retrieval_reasons` (`project_id`,`revision`,`evidence_node_id`);--> statement-breakpoint
CREATE TABLE `tracemind_graph_revisions` (
	`project_id` text NOT NULL,
	`revision` text NOT NULL,
	`schema_version` integer NOT NULL,
	`captured_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `revision`)
);
--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_revisions_captured_at` ON `tracemind_graph_revisions` (`project_id`,`captured_at`);