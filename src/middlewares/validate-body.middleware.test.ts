import { z } from 'zod';
import { validateBody } from './validate-body.middleware';

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   return res;
}

const schema = z.object({
   name: z.string().min(1),
   age: z.number().int().positive(),
});

describe('validateBody', () => {
   it('calls next() and replaces req.body with the parsed data on success', () => {
      const req: any = { body: { name: 'Ada', age: 30 } };
      const res = makeRes();
      const next = jest.fn();

      validateBody(schema)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.body).toEqual({ name: 'Ada', age: 30 });
   });

   it('strips unknown fields before reaching the controller', () => {
      const req: any = {
         body: { name: 'Ada', age: 30, isAdmin: true, extra: 'nope' },
      };
      const res = makeRes();
      const next = jest.fn();

      validateBody(schema)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body).toEqual({ name: 'Ada', age: 30 });
      expect(req.body).not.toHaveProperty('isAdmin');
      expect(req.body).not.toHaveProperty('extra');
   });

   it('returns 422 with per-field details when a required field is missing', () => {
      const req: any = { body: { age: 30 } };
      const res = makeRes();
      const next = jest.fn();

      validateBody(schema)(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.details).toEqual(
         expect.arrayContaining([
            expect.objectContaining({ field: 'name' }),
         ])
      );
   });

   it('returns 422 with the field name and message when a type is wrong', () => {
      const req: any = { body: { name: 'Ada', age: 'not-a-number' } };
      const res = makeRes();
      const next = jest.fn();

      validateBody(schema)(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      const body = res.json.mock.calls[0][0];
      expect(body.error.details[0].field).toBe('age');
      expect(body.error.details[0].message).toEqual(expect.any(String));
   });

   it('passes valid bodies through unchanged (no extraneous mutation)', () => {
      const req: any = { body: { name: 'Grace', age: 42 } };
      const res = makeRes();
      const next = jest.fn();

      validateBody(schema)(req, res, next);

      expect(req.body).toEqual({ name: 'Grace', age: 42 });
   });
});
