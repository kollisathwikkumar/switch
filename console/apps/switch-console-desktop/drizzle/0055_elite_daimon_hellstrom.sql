DROP INDEX `idx_tracemind_graph_nodes_source`;--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_nodes_source` ON `tracemind_graph_nodes` (`project_id`,`revision`,`source_path`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tracemind_graph_relationships` (
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
	FOREIGN KEY (`project_id`,`revision`) REFERENCES `tracemind_graph_revisions`(`project_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`revision`,`source_id`) REFERENCES `tracemind_graph_nodes`(`project_id`,`revision`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`revision`,`target_id`) REFERENCES `tracemind_graph_nodes`(`project_id`,`revision`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tracemind_graph_relationships`("project_id", "revision", "id", "source_id", "target_id", "relation", "source_path", "stale", "payload") SELECT "project_id", "revision", "id", "source_id", "target_id", "relation", "source_path", "stale", "payload" FROM `tracemind_graph_relationships`;--> statement-breakpoint
DROP TABLE `tracemind_graph_relationships`;--> statement-breakpoint
ALTER TABLE `__new_tracemind_graph_relationships` RENAME TO `tracemind_graph_relationships`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_revision` ON `tracemind_graph_relationships` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_source` ON `tracemind_graph_relationships` (`project_id`,`revision`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_target` ON `tracemind_graph_relationships` (`project_id`,`revision`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_relationships_path` ON `tracemind_graph_relationships` (`project_id`,`revision`,`source_path`);--> statement-breakpoint
CREATE TABLE `__new_tracemind_graph_retrieval_reasons` (
	`project_id` text NOT NULL,
	`revision` text NOT NULL,
	`id` text NOT NULL,
	`evidence_node_id` text NOT NULL,
	`reason` text NOT NULL,
	`retrieved_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `revision`, `id`),
	FOREIGN KEY (`project_id`,`revision`) REFERENCES `tracemind_graph_revisions`(`project_id`,`revision`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`,`revision`,`evidence_node_id`) REFERENCES `tracemind_graph_nodes`(`project_id`,`revision`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_tracemind_graph_retrieval_reasons`("project_id", "revision", "id", "evidence_node_id", "reason", "retrieved_at") SELECT "project_id", "revision", "id", "evidence_node_id", "reason", "retrieved_at" FROM `tracemind_graph_retrieval_reasons`;--> statement-breakpoint
DROP TABLE `tracemind_graph_retrieval_reasons`;--> statement-breakpoint
ALTER TABLE `__new_tracemind_graph_retrieval_reasons` RENAME TO `tracemind_graph_retrieval_reasons`;--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_retrieval_reasons_revision` ON `tracemind_graph_retrieval_reasons` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tracemind_graph_retrieval_reasons_evidence` ON `tracemind_graph_retrieval_reasons` (`project_id`,`revision`,`evidence_node_id`);