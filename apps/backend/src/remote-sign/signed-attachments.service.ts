// apps/backend/src/remote-sign/signed-attachments.service.ts
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import AdmZip from 'adm-zip';
import { getUploadsDir } from '../attachments/attachment-paths.js';
import { extractZipWithYauzl, flattenZipEntryName } from '../campaigns/zip-extract.util.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import type { CampaignRequester } from '../campaigns/campaigns.service.js';
import { RemoteSignService } from './remote-sign.service.js';
import { matchSignedFiles } from './signed-attachment-matcher.util.js';
import { replaceAttachment } from './attachment-writer.util.js';

@Injectable()
export class SignedAttachmentsService {
  constructor(
    private readonly remoteSign: RemoteSignService,
    private readonly verificationBulk: SignatureVerificationBulkService,
    private readonly audit: AuditLogsService,
  ) {}

  async buildUnsignedZip(campaignId: string, requester: CampaignRequester): Promise<Buffer | { error: string }> {
    await this.remoteSign.assertCanModify(campaignId, requester);
    const verification = await this.verificationBulk.getLatestStatus(campaignId);
    if (!verification || verification.status !== SignatureVerificationJobStatus.DONE) {
      return { error: 'Attendi la fine della verifica firma' };
    }
    const { toSign } = await this.remoteSign.listFilesToSign(campaignId);
    const zip = new AdmZip();
    for (const f of toSign) {
      const path = join(getUploadsDir(campaignId), f);
      if (fs.existsSync(path)) zip.addLocalFile(path);
    }
    return zip.toBuffer();
  }

  /**
   * Ricarico firmati: estrazione in cartella temporanea (MAI in uploads —
   * finalizeAttachments/estrazione diretta svuoterebbe la cartella su un
   * nome sbagliato), abbinamento per nome, sostituzione col nome originale.
   */
  async applySignedUpload(
    campaignId: string,
    requester: CampaignRequester,
    uploadedPath: string,
    uploadedName: string,
  ): Promise<{ replaced: number; rejected: Array<{ file: string; reason: string }> } | { error: string }> {
    const campaign = await this.remoteSign.assertCanModify(campaignId, requester);
    if (await this.remoteSign.hasActiveJob(campaignId)) {
      fs.rmSync(uploadedPath, { force: true });
      return { error: 'Firma remota in corso: attendi la fine prima di ricaricare' };
    }
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-signed-'));
    try {
      let names: string[];
      if (uploadedName.toLowerCase().endsWith('.zip')) {
        // Elenco completo (anche non-PDF/.p7m, che extractZipWithYauzl salta
        // in silenzio) per poterli riportare come rifiutati col motivo.
        names = new AdmZip(uploadedPath).getEntries()
          .filter((e) => !e.isDirectory)
          .map((e) => flattenZipEntryName(e.entryName));
        await extractZipWithYauzl(uploadedPath, tmp);
      } else {
        names = [uploadedName];
        fs.copyFileSync(uploadedPath, join(tmp, uploadedName));
      }

      const { toSign, alreadyValid } = await this.remoteSign.listFilesToSign(campaignId);
      const { matched, rejected } = matchSignedFiles(names, toSign, alreadyValid);
      for (const m of matched) {
        replaceAttachment(campaignId, m.original, fs.readFileSync(join(tmp, m.uploaded)));
      }
      if (matched.length > 0) await this.verificationBulk.startForCampaign(campaignId);
      await this.audit.log({
        campaignId,
        campaignName: campaign.name ?? null,
        operator: requester.username,
        action: 'UPLOAD_SIGNED_ATTACHMENTS',
        details: { filename: uploadedName, replaced: matched.length, rejected: rejected.length },
      });
      return { replaced: matched.length, rejected };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(uploadedPath, { force: true });
    }
  }
}
