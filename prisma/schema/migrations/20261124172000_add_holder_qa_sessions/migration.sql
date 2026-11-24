-- CreateTable
CREATE TABLE "qa_sessions" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "minBalance" DECIMAL(36,7) NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qa_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_questions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "authorWallet" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qa_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_votes" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qa_sessions_keyId_startsAt_idx" ON "qa_sessions"("keyId", "startsAt");

-- CreateIndex
CREATE INDEX "qa_questions_sessionId_voteCount_idx" ON "qa_questions"("sessionId", "voteCount" DESC);

-- CreateIndex
CREATE INDEX "qa_questions_sessionId_authorWallet_answered_idx" ON "qa_questions"("sessionId", "authorWallet", "answered");

-- CreateIndex
CREATE UNIQUE INDEX "qa_votes_questionId_walletAddress_key" ON "qa_votes"("questionId", "walletAddress");

-- CreateIndex
CREATE INDEX "qa_votes_questionId_idx" ON "qa_votes"("questionId");

-- AddForeignKey
ALTER TABLE "qa_questions" ADD CONSTRAINT "qa_questions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "qa_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_votes" ADD CONSTRAINT "qa_votes_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "qa_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
