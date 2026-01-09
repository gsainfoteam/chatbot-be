export class AdminContext {
  private readonly _email: string;
  private readonly _uuid: string;
  private readonly _name: string;

  get email(): string {
    return this._email;
  }

  get uuid(): string {
    return this._uuid;
  }

  get name(): string {
    return this._name;
  }

  constructor(email: string, uuid: string, name: string) {
    this._email = email;
    this._uuid = uuid;
    this._name = name;
  }
}
