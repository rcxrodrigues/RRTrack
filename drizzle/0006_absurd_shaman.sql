CREATE UNIQUE INDEX "gateway_conn_secret" ON "gateway_connections" USING btree ("webhook_secret");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_public_key" ON "sites" USING btree ("public_key");