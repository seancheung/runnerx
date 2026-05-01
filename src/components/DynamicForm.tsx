import { useEffect, useMemo } from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  useForm,
  type FieldValues,
} from "react-hook-form";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  EnumOption,
  InputSpec,
  Manifest,
  OutputSpec,
  WhenClause,
} from "../types/manifest";

export interface FormValues {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

interface Props {
  manifest: Manifest;
  disabled: boolean;
  onSubmit: (values: FormValues) => void;
}

export function DynamicForm({ manifest, disabled, onSubmit }: Props) {
  const defaults = useMemo(() => buildDefaults(manifest), [manifest]);
  const methods = useForm<FormValues>({ defaultValues: defaults, mode: "onSubmit" });

  // Reset whenever manifest changes (selecting a different script)
  useEffect(() => {
    methods.reset(defaults);
  }, [defaults, methods]);

  const inputs = manifest.inputs ?? [];
  const outputs = manifest.outputs ?? [];

  const handleRun = methods.handleSubmit((values) => {
    const visible = visibleInputIds(inputs, values.inputs as Record<string, unknown>);
    const visibleInputs: Record<string, unknown> = {};
    for (const id of visible) visibleInputs[id] = (values.inputs as Record<string, unknown>)[id];
    onSubmit({ inputs: visibleInputs, outputs: values.outputs ?? {} });
  });

  return (
    <FormProvider {...methods}>
      <form
        // 不让回车触发运行（容易误操作）。运行只能由按钮触发。
        onSubmit={(e) => e.preventDefault()}
      >
        {inputs.length > 0 && (
          <>
            <div className="field-section-title">输入参数</div>
            {inputs.map((spec) => (
              <ConditionalField key={spec.id} spec={spec} disabled={disabled} />
            ))}
          </>
        )}

        {outputs.length > 0 && (
          <>
            <div className="field-section-title">输出</div>
            {outputs.map((spec) => (
              <OutputField key={spec.id} spec={spec} disabled={disabled} />
            ))}
          </>
        )}

        <button className="primary" type="button" onClick={handleRun} disabled={disabled}>
          运行
        </button>
      </form>
    </FormProvider>
  );
}

function buildDefaults(manifest: Manifest): FormValues {
  const inputs: Record<string, unknown> = {};
  for (const i of manifest.inputs ?? []) {
    if (i.default !== undefined) inputs[i.id] = i.default;
    else if (i.type === "boolean") inputs[i.id] = false;
    else if (i.type === "files" || (i.type === "enum" && i.multiple)) inputs[i.id] = [];
    else inputs[i.id] = "";
  }
  const outputs: Record<string, unknown> = {};
  for (const o of manifest.outputs ?? []) {
    outputs[o.id] = "";
  }
  return { inputs, outputs };
}

function ConditionalField({ spec, disabled }: { spec: InputSpec; disabled: boolean }) {
  const { watch } = useFormContext<FormValues>();
  const allInputs = watch("inputs") as Record<string, unknown>;
  if (!isVisible(spec.when, allInputs)) return null;
  return <InputField spec={spec} disabled={disabled} />;
}

function isVisible(when: WhenClause | undefined, values: Record<string, unknown>): boolean {
  if (!when) return true;
  for (const [key, expected] of Object.entries(when)) {
    const actual = values[key];
    if (Array.isArray(expected)) {
      if (!expected.some((v) => v === actual)) return false;
    } else if (expected !== actual) {
      return false;
    }
  }
  return true;
}

function fieldName(spec: InputSpec) { return `inputs.${spec.id}` as const; }

function InputField({ spec, disabled }: { spec: InputSpec; disabled: boolean }) {
  const label = spec.label ?? spec.id;
  return (
    <div className="field">
      {spec.type !== "boolean" && (
        <label className="field-label">
          {label}
          {spec.required && <span className="field-required">*</span>}
        </label>
      )}
      <FieldBody spec={spec} disabled={disabled} />
      {spec.description && <div className="field-desc">{spec.description}</div>}
      <FieldError name={fieldName(spec)} />
    </div>
  );
}

function FieldError({ name }: { name: string }) {
  const { formState } = useFormContext();
  const err = name.split(".").reduce<any>((acc, k) => acc?.[k], formState.errors);
  if (!err?.message) return null;
  return <div className="field-error">{String(err.message)}</div>;
}

function FieldBody({ spec, disabled }: { spec: InputSpec; disabled: boolean }) {
  const { register, control } = useFormContext<FormValues>();
  const name = fieldName(spec);

  switch (spec.type) {
    case "string":
      if (spec.multiline) {
        return (
          <textarea
            rows={4}
            disabled={disabled}
            placeholder={spec.placeholder}
            {...register(name, {
              required: spec.required ? "必填" : undefined,
              minLength: spec.minLength
                ? { value: spec.minLength, message: `至少 ${spec.minLength} 个字符` }
                : undefined,
              maxLength: spec.maxLength
                ? { value: spec.maxLength, message: `最多 ${spec.maxLength} 个字符` }
                : undefined,
              pattern: spec.pattern ? { value: new RegExp(spec.pattern), message: "格式不匹配" } : undefined,
            })}
          />
        );
      }
      return (
        <input
          type="text"
          disabled={disabled}
          placeholder={spec.placeholder}
          {...register(name, {
            required: spec.required ? "必填" : undefined,
            pattern: spec.pattern ? { value: new RegExp(spec.pattern), message: "格式不匹配" } : undefined,
          })}
        />
      );

    case "password":
      return <input type="password" disabled={disabled} placeholder={spec.placeholder}
        {...register(name, { required: spec.required ? "必填" : undefined })}
      />;

    case "number":
      return (
        <input
          type="number"
          disabled={disabled}
          placeholder={spec.placeholder}
          step={spec.step ?? (spec.integer ? 1 : "any")}
          min={spec.min}
          max={spec.max}
          {...register(name, {
            required: spec.required ? "必填" : undefined,
            valueAsNumber: true,
            min: spec.min !== undefined ? { value: spec.min, message: `不能小于 ${spec.min}` } : undefined,
            max: spec.max !== undefined ? { value: spec.max, message: `不能大于 ${spec.max}` } : undefined,
          })}
        />
      );

    case "boolean":
      return (
        <label className="field-checkbox">
          <input type="checkbox" disabled={disabled} {...register(name)} />
          <span>{spec.label ?? spec.id}</span>
        </label>
      );

    case "enum":
      return (
        <Controller
          control={control}
          name={name}
          rules={{ required: spec.required ? "必填" : undefined }}
          render={({ field }) =>
            spec.multiple ? (
              <MultiEnum options={spec.options} value={(field.value as any[]) ?? []} onChange={field.onChange} disabled={disabled} />
            ) : (
              <select disabled={disabled} value={field.value as string} onChange={(e) => field.onChange(e.target.value)}>
                <option value="">— 请选择 —</option>
                {spec.options.map((opt) => {
                  const o = normalizeOption(opt);
                  return <option key={String(o.value)} value={String(o.value)}>{o.label}</option>;
                })}
              </select>
            )
          }
        />
      );

    case "file":
    case "files":
      return (
        <Controller
          control={control}
          name={name}
          rules={{
            validate: (v) => {
              if (!spec.required) return true;
              if (spec.type === "files") return Array.isArray(v) && v.length > 0 ? true : "至少选择一个文件";
              return v ? true : "必填";
            },
          }}
          render={({ field }) => (
            <FilePicker
              spec={spec}
              value={field.value}
              onChange={field.onChange}
              disabled={disabled}
            />
          )}
        />
      );

    case "directory":
      return (
        <Controller
          control={control}
          name={name}
          rules={{ required: spec.required ? "必填" : undefined }}
          render={({ field }) => (
            <DirectoryPicker value={field.value as string} onChange={field.onChange} disabled={disabled} />
          )}
        />
      );

    case "date":
      return (
        <input type="date" disabled={disabled} min={spec.minDate} max={spec.maxDate}
          {...register(name, { required: spec.required ? "必填" : undefined })}
        />
      );

    case "json":
      return (
        <Controller
          control={control}
          name={name}
          rules={{
            validate: (v) => {
              if (!v) return spec.required ? "必填" : true;
              try {
                if (typeof v === "string") JSON.parse(v);
                return true;
              } catch {
                return "JSON 格式错误";
              }
            },
          }}
          render={({ field }) => (
            <textarea
              rows={5}
              disabled={disabled}
              placeholder={spec.placeholder ?? '例如 {"key": "value"}'}
              value={typeof field.value === "string" ? field.value : JSON.stringify(field.value ?? "", null, 2)}
              onChange={(e) => field.onChange(e.target.value)}
            />
          )}
        />
      );
  }
}

function normalizeOption(opt: EnumOption): { value: string | number | boolean; label: string } {
  if (typeof opt === "string") return { value: opt, label: opt };
  return { value: opt.value, label: opt.label ?? String(opt.value) };
}

function MultiEnum({
  options, value, onChange, disabled,
}: {
  options: EnumOption[];
  value: unknown[];
  onChange: (v: unknown[]) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {options.map((opt) => {
        const o = normalizeOption(opt);
        const checked = value.some((v) => v === o.value);
        return (
          <label key={String(o.value)} className="field-checkbox" style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", padding: "4px 8px", borderRadius: 6 }}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={checked}
              onChange={(e) => {
                if (e.target.checked) onChange([...value, o.value]);
                else onChange(value.filter((v) => v !== o.value));
              }}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function FilePicker({
  spec, value, onChange, disabled,
}: {
  spec: Extract<InputSpec, { type: "file" | "files" }>;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const isMulti = spec.type === "files";
  const filters = spec.accept && spec.accept.length > 0
    ? [{ name: "Allowed", extensions: spec.accept.map(stripDot) }]
    : undefined;

  const pick = async () => {
    const picked = await openDialog({ multiple: isMulti, filters });
    if (picked == null) return;
    onChange(picked);
  };

  const display = !value
    ? "（未选择）"
    : Array.isArray(value)
      ? value.length === 0 ? "（未选择）" : `${value.length} 个文件`
      : String(value);

  return (
    <div className="field-row">
      <input readOnly value={display} disabled={disabled} />
      <button type="button" onClick={pick} disabled={disabled}>选择…</button>
      {!!value && !isMulti && (
        <button type="button" onClick={() => onChange("")} disabled={disabled}>清除</button>
      )}
    </div>
  );
}

function DirectoryPicker({
  value, onChange, disabled,
}: { value: string | undefined; onChange: (v: string) => void; disabled: boolean }) {
  const pick = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <div className="field-row">
      <input readOnly value={value || ""} placeholder="（未选择）" disabled={disabled} />
      <button type="button" onClick={pick} disabled={disabled}>选择…</button>
    </div>
  );
}

function OutputField({ spec, disabled }: { spec: OutputSpec; disabled: boolean }) {
  const { control } = useFormContext<FormValues>();
  const name = `outputs.${spec.id}` as const;
  const required = spec.required ?? true;
  return (
    <div className="field">
      <label className="field-label">
        {spec.label ?? spec.id}
        {required && <span className="field-required">*</span>}
      </label>
      <Controller
        control={control}
        name={name}
        rules={{ required: required ? "请选择保存路径" : undefined }}
        render={({ field }) => (
          <SaveTarget spec={spec} value={field.value as string} onChange={field.onChange} disabled={disabled} />
        )}
      />
      {spec.description && <div className="field-desc">{spec.description}</div>}
      <FieldError name={name} />
    </div>
  );
}

function SaveTarget({
  spec, value, onChange, disabled,
}: { spec: OutputSpec; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const pick = async () => {
    if (spec.type === "directory") {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") onChange(picked);
      return;
    }
    const picked = await saveDialog({
      filters: spec.accept && spec.accept.length > 0
        ? [{ name: "Allowed", extensions: spec.accept.map(stripDot) }]
        : undefined,
    });
    if (typeof picked === "string") onChange(picked);
  };
  return (
    <div className="field-row">
      <input readOnly value={value || ""} placeholder="（未选择）" disabled={disabled} />
      <button type="button" onClick={pick} disabled={disabled}>选择…</button>
    </div>
  );
}

function stripDot(ext: string): string {
  return ext.startsWith(".") ? ext.slice(1) : ext;
}

function visibleInputIds(specs: InputSpec[], values: Record<string, unknown>): string[] {
  return specs.filter((s) => isVisible(s.when, values)).map((s) => s.id);
}

// Suppress unused warning for FieldValues import if not used elsewhere
export type _FV = FieldValues;
