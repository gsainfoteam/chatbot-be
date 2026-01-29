export class AdminContext {
  private readonly _email: string;
  private readonly _uuid: string;
  private readonly _name: string;
  private readonly _role: string;

  get email(): string {
    return this._email;
  }

  get uuid(): string {
    return this._uuid;
  }

  get name(): string {
    return this._name;
  }

  get role(): string {
    return this._role;
  }

  constructor(email: string, uuid: string, name: string, role: string) {
    this._email = email;
    this._uuid = uuid;
    this._name = name;
    this._role = role;
  }
}
