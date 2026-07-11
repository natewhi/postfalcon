export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'validation_failed', details: result.error.flatten() });
    }
    req.body = result.data;
    next();
  };
}
