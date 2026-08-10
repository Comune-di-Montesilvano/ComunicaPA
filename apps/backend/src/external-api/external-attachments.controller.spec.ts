import { ExternalAttachmentsController } from './external-attachments.controller';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import * as chunkedUpload from '../campaigns/chunked-upload.util';

jest.mock('../campaigns/chunked-upload.util');

describe('ExternalAttachmentsController', () => {
  let controller: ExternalAttachmentsController;
  let tokens: { completeUpload: jest.Mock };
  const req = { apiClient: { id: 'client-1' } } as any;

  beforeEach(() => {
    tokens = { completeUpload: jest.fn().mockResolvedValue({ token: 'tok-1' }) };
    controller = new ExternalAttachmentsController(tokens as unknown as ExternalAttachmentTokensService);
    (chunkedUpload.initChunkedUpload as jest.Mock).mockReturnValue('upload-1');
  });

  it('init ritorna uploadId', () => {
    const result = controller.init({ filename: 'avviso.pdf', totalChunks: 2 });
    expect(result).toEqual({ success: true, uploadId: 'upload-1' });
  });

  it('complete ritorna attachmentToken scoped al client della richiesta', async () => {
    const result = await controller.complete({ uploadId: 'upload-1' }, req);
    expect(tokens.completeUpload).toHaveBeenCalledWith('client-1', 'upload-1');
    expect(result).toEqual({ success: true, attachmentToken: 'tok-1' });
  });
});
