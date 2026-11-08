CREATE TABLE "tip_content" (
    "id" TEXT NOT NULL,
    "tip_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tip_content_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tip_content_tip_id_key" ON "tip_content"("tip_id");
CREATE INDEX "Event_topic_idx" ON "Event"("topic");
