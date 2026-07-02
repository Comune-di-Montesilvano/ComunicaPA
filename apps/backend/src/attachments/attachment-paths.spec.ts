import { join } from 'path';
import { getAttachmentsRoot, getUploadsDir, getBrandingDir } from './attachment-paths';

describe('attachment-paths', () => {
  afterEach(() => {
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('default /data/attachments', () => {
    expect(getAttachmentsRoot()).toBe('/data/attachments');
  });

  it('rispetta ATTACHMENTS_PATH', () => {
    process.env['ATTACHMENTS_PATH'] = '/mnt/allegati';
    expect(getAttachmentsRoot()).toBe('/mnt/allegati');
    expect(getUploadsDir('camp-1')).toBe(join('/mnt/allegati', 'uploads', 'camp-1'));
    expect(getBrandingDir()).toBe(join('/mnt/allegati', 'branding'));
  });
});
