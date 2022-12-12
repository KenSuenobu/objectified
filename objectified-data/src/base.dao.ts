export class BaseDao<T> {
  constructor(private readonly section: string) { }

  async list(): Promise<T[]> {
    const selectStatement = `SELECT * FROM ${this.section}`;

    return null;
  }

  async getById(id: number): Promise<T> {
    const selectStatement = `SELECT * FROM ${this.section} WHERE id=$1`;

    return null;
  }

  async deleteById(id: number): Promise<Boolean> {
    const deleteStatement = `UPDATE ${this.section} SET enabled=false, delete_date=NOW() WHERE id=$1`;

    return false;
  }

  getSection(): string {
    return this.section;
  }
}
